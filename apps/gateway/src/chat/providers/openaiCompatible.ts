import { randomUUID } from 'node:crypto';
import { toObject, type ChatProvider, type CompletionRequest, type ModelTurn, type StopReason, type Turn } from '../types.ts';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

interface OaiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface OaiResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: OaiToolCall[] }; finish_reason?: string }>;
  error?: { message?: string } | string;
}

function toMessages(system: string, turns: Turn[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const t of turns) {
    if (t.role === 'user') out.push({ role: 'user', content: t.content });
    else if (t.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: t.content || null };
      if (t.toolCalls.length) msg.tool_calls = t.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      out.push(msg);
    } else {
      for (const r of t.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}

function mapStop(reason: string | undefined, hasCalls: boolean): StopReason {
  if (hasCalls || reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** Any `/v1/chat/completions` server (Ollama, vLLM, OpenAI…) with the function-calling format. */
export class OpenAiCompatibleProvider implements ChatProvider {
  readonly provider = 'openai_compatible';
  readonly model: string;
  private readonly opts: OpenAiCompatibleOptions;

  constructor(opts: OpenAiCompatibleOptions) {
    this.opts = opts;
    this.model = opts.model;
  }

  async complete(req: CompletionRequest): Promise<ModelTurn> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const body: Record<string, unknown> = { model: this.model, messages: toMessages(req.system, req.turns) };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    const text = await res.text();
    let json: OaiResponse;
    try {
      json = JSON.parse(text) as OaiResponse;
    } catch {
      throw new Error(`LLM returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const msg = typeof json.error === 'string' ? json.error : json.error?.message;
      throw new Error(`LLM HTTP ${res.status}: ${msg ?? text.slice(0, 200)}`);
    }
    const choice = json.choices?.[0];
    const calls = (choice?.message?.tool_calls ?? []).filter((c) => c.function?.name);
    const turn: ModelTurn = { text: choice?.message?.content ?? '', toolCalls: [], stopReason: mapStop(choice?.finish_reason, calls.length > 0) };
    for (const [i, c] of calls.entries()) {
      let args: unknown = {};
      try {
        args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        args = {};
      }
      turn.toolCalls.push({ id: c.id ?? `call_${randomUUID().slice(0, 8)}_${i}`, name: c.function?.name ?? '', args: toObject(args) });
    }
    return turn;
  }
}
