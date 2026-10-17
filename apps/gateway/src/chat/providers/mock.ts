import { randomUUID } from 'node:crypto';
import { PREVIEW_MAX, type ChatProvider, type CompletionRequest, type ModelTurn, type Turn } from '../types.ts';

const CALL_RE = /call\s+([A-Za-z0-9_.-]+)\s*(\{[\s\S]*\})?/;

/**
 * Deterministic provider for tests and demos without a key.
 * `call <publicName> <json>` in the last user message → one tool call, then `Called <name>: <preview>`;
 * anything else → `mock: <echo>`.
 */
export class MockProvider implements ChatProvider {
  readonly provider = 'mock';
  readonly model: string;

  constructor(model = 'mock-1') {
    this.model = model;
  }

  async complete(req: CompletionRequest): Promise<ModelTurn> {
    const last = req.turns[req.turns.length - 1];
    if (last?.role === 'tool_results') {
      const text = last.results.map((r) => `Called ${r.name}: ${r.content.slice(0, PREVIEW_MAX)}`).join('\n');
      return { text, toolCalls: [], stopReason: 'end_turn' };
    }
    const lastUser = [...req.turns].reverse().find((t): t is Extract<Turn, { role: 'user' }> => t.role === 'user');
    const content = lastUser?.content ?? '';
    const m = CALL_RE.exec(content);
    if (m?.[1]) {
      let args: Record<string, unknown> = {};
      if (m[2]) {
        try {
          args = JSON.parse(m[2]) as Record<string, unknown>;
        } catch {
          return { text: 'mock: the JSON arguments could not be parsed', toolCalls: [], stopReason: 'end_turn' };
        }
      }
      const known = req.tools.some((t) => t.name === m[1]);
      const name = known || !req.tools.some((t) => t.name === 'call_tool') ? m[1] : 'call_tool';
      const callArgs = name === 'call_tool' && name !== m[1] ? { name: m[1], arguments: args } : args;
      return { text: '', toolCalls: [{ id: `mock_${randomUUID().slice(0, 8)}`, name, args: callArgs }], stopReason: 'tool_use' };
    }
    return { text: `mock: ${content}`, toolCalls: [], stopReason: 'end_turn' };
  }
}
