import { Fragment, type ReactNode } from 'react';

/**
 * Tiny, dependency-free Markdown renderer for assistant replies — enough of the
 * common subset (headings, bold/italic, inline + fenced code, bullet/numbered
 * lists, blockquotes, links) to make answers read cleanly instead of showing raw
 * `**asterisks**`. Everything is built as React nodes (no dangerouslySetInnerHTML),
 * so user/model text is always escaped and links are scheme-checked.
 */
export function Markdown({ content }: { content: string }) {
  return <div className="space-y-3 leading-7">{renderBlocks(content)}</div>;
}

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'p'; lines: string[] };

/** Group raw lines into block structures, then render each. */
function renderBlocks(content: string): ReactNode[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block: ``` ... ```
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or EOF)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i++]!.replace(/^\s*[-*+]\s+/, ''));
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ''));
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quote.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      }
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }

    // Paragraph: consecutive plain lines until a blank line or a new block.
    const para: string[] = [];
    while (
      i < lines.length
      && lines[i]!.trim() !== ''
      && !/^\s*```/.test(lines[i]!)
      && !/^(#{1,6})\s+/.test(lines[i]!)
      && !/^\s*[-*+]\s+/.test(lines[i]!)
      && !/^\s*\d+[.)]\s+/.test(lines[i]!)
      && !/^\s*>\s?/.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push({ kind: 'p', lines: para });
  }

  return blocks.map((block, index) => renderBlock(block, index));
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'code':
      return (
        <pre key={key} className="overflow-x-auto border border-ares-line bg-black/50 p-3 font-mono text-xs leading-6 text-ares-cyanSoft">
          <code>{block.text}</code>
        </pre>
      );
    case 'heading': {
      const cls = block.level <= 2
        ? 'font-mono text-sm font-bold uppercase tracking-[0.16em] text-ares-cyan'
        : 'font-mono text-xs font-bold uppercase tracking-[0.12em] text-ares-cyanSoft';
      return <div key={key} className={cls}>{renderInline(block.text)}</div>;
    }
    case 'ul':
      return (
        <ul key={key} className="ml-1 space-y-1">
          {block.items.map((item, n) => (
            <li key={n} className="flex gap-2">
              <span className="mt-[0.55em] h-1 w-1 shrink-0 bg-ares-cyan shadow-[0_0_6px_#00d9ff]" />
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} className="ml-1 space-y-1">
          {block.items.map((item, n) => (
            <li key={n} className="flex gap-2">
              <span className="shrink-0 font-mono text-xs text-ares-amber">{(n + 1).toString().padStart(2, '0')}</span>
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote key={key} className="border-l-2 border-ares-cyan/50 pl-3 text-slate-300/90 italic">
          {block.lines.map((line, n) => <div key={n}>{renderInline(line)}</div>)}
        </blockquote>
      );
    case 'p':
      return (
        <p key={key}>
          {block.lines.map((line, n) => (
            <Fragment key={n}>
              {n > 0 && <br />}
              {renderInline(line)}
            </Fragment>
          ))}
        </p>
      );
  }
}

// Inline markup, scanned earliest-match-first. Code is matched first so its
// contents are never re-parsed as bold/italic.
const INLINE = new RegExp(
  [
    '(`[^`]+`)',                       // 1 inline code
    '(\\*\\*[^*]+\\*\\*|__[^_]+__)',   // 2 bold
    '(\\*[^*\\s][^*]*\\*|_[^_\\s][^_]*_)', // 3 italic
    '(~~[^~]+~~)',                     // 4 strikethrough
    '(\\[[^\\]]+\\]\\([^)\\s]+\\))',   // 5 link
  ].join('|'),
);

/** Parse inline markup in `text` into React nodes. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const token = match[0];

    if (match[1]) {
      nodes.push(<code key={key++} className="border border-ares-line bg-black/40 px-1 py-0.5 font-mono text-[0.85em] text-ares-cyanSoft">{token.slice(1, -1)}</code>);
    } else if (match[2]) {
      nodes.push(<strong key={key++} className="font-semibold text-white">{renderInline(token.replace(/^(\*\*|__)|(\*\*|__)$/g, ''))}</strong>);
    } else if (match[3]) {
      nodes.push(<em key={key++} className="italic text-slate-200">{renderInline(token.slice(1, -1))}</em>);
    } else if (match[4]) {
      nodes.push(<span key={key++} className="text-ares-muted line-through">{renderInline(token.slice(2, -2))}</span>);
    } else if (match[5]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) {
        const href = safeHref(link[2]!);
        nodes.push(
          href
            ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="text-ares-cyan underline decoration-ares-cyan/40 underline-offset-2 hover:text-white">{link[1]}</a>
            : <span key={key++}>{link[1]}</span>,
        );
      } else {
        nodes.push(token);
      }
    }
    rest = rest.slice(match.index + token.length);
  }

  return nodes;
}

/** Allow only safe link schemes; reject javascript:, data:, etc. */
function safeHref(url: string): string | null {
  if (/^(https?:\/\/|mailto:|\/|#)/i.test(url)) return url;
  return null;
}
