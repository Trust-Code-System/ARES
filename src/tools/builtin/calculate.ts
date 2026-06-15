/**
 * Read-only example tool: evaluate an arithmetic expression deterministically.
 *
 * Demonstrates the "deterministic where it matters" principle — math is done in
 * code, not by the model. Uses a tiny shunting-yard evaluator (no `eval`, no
 * `Function`) over a strict token set so there is no code-execution surface.
 */

import { z } from 'zod';
import type { ToolResult } from '../../types.js';
import { defineTool } from '../define.js';

export const calculate = defineTool({
  name: 'calculate',
  description:
    'Evaluate a basic arithmetic expression with + - * / % ^ and parentheses. ' +
    'Use this instead of doing math yourself when accuracy matters.',
  kind: 'read_only',
  schema: z.object({
    expression: z.string().describe('e.g. "(1200 * 1.08) / 12"'),
  }),
  async execute(input): Promise<ToolResult> {
    try {
      const value = evaluate(input.expression);
      if (!Number.isFinite(value)) {
        return { ok: false, content: 'Result is not a finite number.' };
      }
      return { ok: true, content: String(value), data: { value } };
    } catch (err) {
      return {
        ok: false,
        content: `Could not evaluate expression: ${(err as Error).message}`,
      };
    }
  },
});

// --- Safe arithmetic evaluator (shunting-yard → RPN) ---

type Token = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'paren'; v: '(' | ')' };

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
const RIGHT_ASSOC = new Set(['^']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t') {
      i++;
    } else if (c >= '0' && c <= '9') {
      let num = '';
      while (i < input.length && /[0-9.]/.test(input[i]!)) num += input[i++]!;
      tokens.push({ t: 'num', v: Number(num) });
    } else if ('+-*/%^'.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
    } else if (c === '(' || c === ')') {
      tokens.push({ t: 'paren', v: c });
      i++;
    } else {
      throw new Error(`unexpected character "${c}"`);
    }
  }
  return tokens;
}

function evaluate(expr: string): number {
  const output: Token[] = [];
  const ops: Token[] = [];

  for (const tok of tokenize(expr)) {
    if (tok.t === 'num') {
      output.push(tok);
    } else if (tok.t === 'op') {
      while (ops.length) {
        const top = ops[ops.length - 1]!;
        if (
          top.t === 'op' &&
          (PREC[top.v]! > PREC[tok.v]! ||
            (PREC[top.v]! === PREC[tok.v]! && !RIGHT_ASSOC.has(tok.v)))
        ) {
          output.push(ops.pop()!);
        } else break;
      }
      ops.push(tok);
    } else if (tok.v === '(') {
      ops.push(tok);
    } else {
      // ')'
      while (ops.length && !(ops[ops.length - 1]!.t === 'paren')) output.push(ops.pop()!);
      if (!ops.length) throw new Error('mismatched parentheses');
      ops.pop(); // discard '('
    }
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op.t === 'paren') throw new Error('mismatched parentheses');
    output.push(op);
  }

  const stack: number[] = [];
  for (const tok of output) {
    if (tok.t === 'num') {
      stack.push(tok.v);
    } else if (tok.t === 'op') {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new Error('malformed expression');
      stack.push(apply(tok.v, a, b));
    }
  }
  if (stack.length !== 1) throw new Error('malformed expression');
  return stack[0]!;
}

function apply(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case '%':
      return a % b;
    case '^':
      return a ** b;
    default:
      throw new Error(`unknown operator ${op}`);
  }
}
