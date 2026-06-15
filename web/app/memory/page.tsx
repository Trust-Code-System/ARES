'use client';

import { useCallback, useEffect, useState } from 'react';
import { HudPanel } from '@/components/HudPanel';
import { EmptyState } from '@/lib/hud';
import { api, type Fact, type FactKind, type SemanticHit } from '@/lib/api';

const FACT_KINDS: FactKind[] = ['fact', 'person', 'project', 'preference', 'decision'];

export default function MemoryBrowser() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [factQuery, setFactQuery] = useState('');
  const [memoryKind, setMemoryKind] = useState<FactKind>('fact');
  const [memorySubject, setMemorySubject] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKind, setEditKind] = useState<FactKind>('fact');
  const [editSubject, setEditSubject] = useState('');
  const [editContent, setEditContent] = useState('');
  const [semQuery, setSemQuery] = useState('');
  const [semHits, setSemHits] = useState<SemanticHit[] | null>(null);
  const [semNote, setSemNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  const refresh = useCallback(async (query?: string) => {
    try {
      const { facts: rows } = await api.memory(query?.trim() || undefined);
      setFacts(rows);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runMutation(action: () => Promise<unknown>): Promise<boolean> {
    setMutating(true);
    try {
      await action();
      await refresh(factQuery);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setMutating(false);
    }
  }

  async function rememberFact() {
    if (!memorySubject.trim() || !memoryContent.trim()) return;
    const saved = await runMutation(() =>
      api.remember({ kind: memoryKind, subject: memorySubject.trim(), content: memoryContent.trim() }),
    );
    if (saved) {
      setMemorySubject('');
      setMemoryContent('');
    }
  }

  function beginEdit(fact: Fact) {
    setEditingId(fact.id);
    setEditKind((FACT_KINDS.includes(fact.kind as FactKind) ? fact.kind : 'fact') as FactKind);
    setEditSubject(fact.subject);
    setEditContent(fact.content);
  }

  /**
   * The API has no in-place fact update, only remember (upsert) + forget. An edit
   * is therefore "write the new version, then drop the old row" — ordered so a
   * mid-way failure leaves the original intact rather than losing the fact.
   */
  async function saveEdit(original: Fact) {
    if (!editSubject.trim() || !editContent.trim()) return;
    const saved = await runMutation(async () => {
      await api.remember({ kind: editKind, subject: editSubject.trim(), content: editContent.trim() });
      const changedKey =
        editKind !== original.kind ||
        editSubject.trim() !== original.subject ||
        editContent.trim() !== original.content;
      if (changedKey) await api.forget(original.id);
    });
    if (saved) setEditingId(null);
  }

  async function searchSemantic() {
    if (!semQuery.trim()) {
      setSemHits(null);
      setSemNote(null);
      return;
    }
    try {
      const result = await api.semanticMemory(semQuery);
      setSemHits(result.hits);
      setSemNote(result.note ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader title="Memory browser" subtitle="Inspect, curate, and probe everything ARES remembers" />

      {error && (
        <div role="alert" className="border border-ares-red/50 bg-ares-red/10 px-4 py-3 font-mono text-xs uppercase tracking-[0.12em] text-red-200 shadow-hud-red">
          <span className="mr-2 text-ares-red">System alert:</span>
          {error}. Confirm that `npm run serve` is running.
        </div>
      )}

      <div className="grid min-w-0 gap-5 xl:grid-cols-12">
        <HudPanel title={`Structured memory / ${facts.length} facts`} code="MEM-01" accent="amber" className="xl:col-span-5">
          <form
            className="mb-4 space-y-2 border border-ares-line bg-black/20 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void rememberFact();
            }}
          >
            <div className="flex gap-2">
              <select
                aria-label="Memory type"
                value={memoryKind}
                onChange={(event) => setMemoryKind(event.target.value as FactKind)}
                className="border border-ares-line bg-ares-bg px-2 font-mono text-[10px] uppercase text-ares-amber outline-none"
              >
                {FACT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
              <input
                aria-label="Memory subject"
                className="hud-input h-9 min-w-0 flex-1 px-2 text-xs"
                placeholder="Subject, project, or person"
                value={memorySubject}
                onChange={(event) => setMemorySubject(event.target.value)}
              />
            </div>
            <textarea
              aria-label="Memory content"
              className="hud-input min-h-20 w-full resize-y px-2 py-2 text-xs"
              placeholder="What should ARES remember?"
              value={memoryContent}
              onChange={(event) => setMemoryContent(event.target.value)}
            />
            <button type="submit" className="hud-button w-full" disabled={mutating || !memorySubject.trim() || !memoryContent.trim()}>
              Commit memory
            </button>
          </form>

          <form
            className="mb-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void refresh(factQuery);
            }}
          >
            <label htmlFor="fact-query" className="sr-only">Filter facts</label>
            <input
              id="fact-query"
              className="hud-input h-9 min-w-0 flex-1 px-3 text-xs"
              placeholder="Filter facts by subject or content..."
              value={factQuery}
              onChange={(event) => setFactQuery(event.target.value)}
            />
            <button type="submit" className="hud-button" disabled={mutating}>Filter</button>
          </form>

          <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
            {facts.length === 0 && <EmptyState text="No structured facts available" />}
            {facts.map((fact) =>
              editingId === fact.id ? (
                <form
                  key={fact.id}
                  className="space-y-2 border border-ares-cyan/40 bg-black/30 p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit(fact);
                  }}
                >
                  <div className="flex gap-2">
                    <select
                      aria-label="Edit memory type"
                      value={editKind}
                      onChange={(event) => setEditKind(event.target.value as FactKind)}
                      className="border border-ares-line bg-ares-bg px-2 font-mono text-[10px] uppercase text-ares-cyan outline-none"
                    >
                      {FACT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                    </select>
                    <input
                      aria-label="Edit memory subject"
                      className="hud-input h-9 min-w-0 flex-1 px-2 text-xs"
                      value={editSubject}
                      onChange={(event) => setEditSubject(event.target.value)}
                    />
                  </div>
                  <textarea
                    aria-label="Edit memory content"
                    className="hud-input min-h-16 w-full resize-y px-2 py-2 text-xs"
                    value={editContent}
                    onChange={(event) => setEditContent(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <button type="submit" className="hud-button flex-1" disabled={mutating || !editSubject.trim() || !editContent.trim()}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="border border-ares-line px-3 font-mono text-[10px] uppercase tracking-wider text-ares-muted transition hover:text-slate-200"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <article key={fact.id} className="border-l border-ares-amber/50 bg-black/20 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ares-amber">{fact.kind}</span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-[9px] text-ares-muted">IMP {fact.importance}</span>
                      <button
                        type="button"
                        className="font-mono text-[9px] uppercase tracking-wider text-ares-cyan/70 transition hover:text-ares-cyan"
                        disabled={mutating}
                        onClick={() => beginEdit(fact)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="font-mono text-[9px] uppercase tracking-wider text-ares-red/70 transition hover:text-ares-red"
                        disabled={mutating}
                        onClick={() => void runMutation(() => api.forget(fact.id))}
                      >
                        Forget
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-sm text-slate-200">
                    <strong className="font-medium text-ares-cyanSoft">{fact.subject}:</strong> {fact.content}
                  </div>
                </article>
              ),
            )}
          </div>
        </HudPanel>

        <HudPanel title="Semantic memory probe" code="VEC-02" className="xl:col-span-7">
          <form
            className="mb-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void searchSemantic();
            }}
          >
            <label htmlFor="semantic-query" className="sr-only">Search semantic memory</label>
            <input
              id="semantic-query"
              className="hud-input h-10 min-w-0 flex-1 px-3"
              placeholder="Search conversation memory by meaning..."
              value={semQuery}
              onChange={(event) => setSemQuery(event.target.value)}
            />
            <button type="submit" className="hud-button" disabled={!semQuery.trim()}>Probe</button>
          </form>

          {semNote && (
            <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ares-amber">{semNote}</p>
          )}

          <div className="max-h-[34rem] space-y-2 overflow-y-auto pr-1">
            {semHits === null && <EmptyState text="Enter a query to scan embedded memory" />}
            {semHits?.length === 0 && <EmptyState text="No matching memory vectors" />}
            {semHits?.map((hit) => (
              <article key={hit.id} className="border border-ares-line bg-black/20 p-3">
                <div className="mb-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.12em]">
                  <span className="text-ares-cyan">{hit.sourceType}</span>
                  <span className="text-ares-muted">Similarity {hit.similarity.toFixed(3)}</span>
                </div>
                <p className="text-sm leading-6 text-slate-300">{hit.content}</p>
              </article>
            ))}
          </div>
        </HudPanel>
      </div>
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3">
      <h1 className="font-mono text-sm uppercase tracking-[0.22em] text-ares-cyan">{title}</h1>
      <span className="h-px flex-1 bg-gradient-to-r from-ares-cyan/40 to-transparent" />
      <span className="hidden font-mono text-[9px] uppercase tracking-[0.16em] text-ares-muted sm:block">{subtitle}</span>
    </div>
  );
}
