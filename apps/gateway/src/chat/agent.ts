import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User } from '../auth/users.ts';
import { ToolCallRejected, type GatewayCore, type PublicTool } from '../core/gatewayCore.ts';
import type { Logger } from '../log.ts';
import { CALL_TOOL, SEARCH_TOOL, metaTools, searchResultText, searchTools } from './toolSearch.ts';
import {
  PREVIEW_MAX,
  TOOL_RESULT_MAX_BYTES,
  toObject,
  type ChatEvent,
  type ChatInputMessage,
  type ChatProvider,
  type ModelToolCall,
  type ToolCallSummary,
  type ToolDef,
  type ToolResultTurn,
  type Turn,
} from './types.ts';

export interface AgentOptions {
  maxIterations: number;
  toolSearchThreshold: number;
}

export function systemPrompt(user: User): string {
  return [
    `You are the assistant of the Urumi MCP gateway. You are talking to ${user.name || user.email} (${user.email}, role: ${user.role}).`,
    'The current date and time is given at the start of the latest user message.',
    'Tools are named <server>__<tool>; the prefix tells you which upstream server executes them. Use tools when they help answer the request and never invent results.',
    'At the end of your answer, state briefly which tools you used (or that none were needed).',
  ].join('\n');
}

export function resultToText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const c of result.content ?? []) {
    if (c.type === 'text') parts.push(c.text);
    else parts.push(`[${c.type} content omitted]`);
  }
  let text = parts.join('\n');
  if (!text && result.structuredContent) text = JSON.stringify(result.structuredContent);
  if (Buffer.byteLength(text) > TOOL_RESULT_MAX_BYTES) {
    text = `${Buffer.from(text).subarray(0, TOOL_RESULT_MAX_BYTES).toString()}\n[truncated: result exceeded 16 KB]`;
  }
  return text;
}

const preview = (s: string): string => (s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) : s);

/**
 * The chat tool loop (contracts §11). Every real tool call goes through `core.callTool(..., {source:'chat'})`
 * so permissions and audit rows are identical to the MCP endpoint.
 */
export class ChatAgent {
  private readonly core: GatewayCore;
  private readonly provider: ChatProvider;
  private readonly opts: AgentOptions;
  private readonly log: Logger;

  constructor(core: GatewayCore, provider: ChatProvider, opts: AgentOptions, log: Logger) {
    this.core = core;
    this.provider = provider;
    this.opts = opts;
    this.log = log;
  }

  async run(user: User, messages: ChatInputMessage[], emit: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
    const visible = this.core.listToolsFor(user);
    const searchMode = visible.length > this.opts.toolSearchThreshold;
    const tools: ToolDef[] = searchMode
      ? metaTools(visible.length)
      : visible.map((t) => ({ name: t.publicName, description: t.description ?? '', inputSchema: t.inputSchema }));
    emit({ event: 'start', data: { model: this.provider.model, provider: this.provider.provider, toolCount: visible.length } });

    const turns: Turn[] = messages.map((m) => (m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content, toolCalls: [] }));
    // The timestamp lives in the latest user turn (not the system prompt) so the cached prefix stays stable.
    const last = turns[turns.length - 1];
    if (last && last.role === 'user') last.content = `(Current date and time, UTC: ${new Date().toISOString()})

${last.content}`;
    const system = systemPrompt(user);
    const calls: ToolCallSummary[] = [];
    let finalText = '';

    try {
      for (let i = 0; i < this.opts.maxIterations; i++) {
        if (signal?.aborted) return; // the client went away: no more model calls, no more tool executions
        const turn = await this.provider.complete({ system, turns, tools });
        if (turn.text) {
          emit({ event: 'text', data: { delta: turn.text } });
          finalText = finalText ? `${finalText}\n${turn.text}` : turn.text;
        }
        turns.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls, ...(turn.raw !== undefined ? { raw: turn.raw } : {}) });

        if (turn.stopReason === 'max_tokens') {
          emit({ event: 'error', data: { message: 'The model hit its output token limit before finishing.' } });
          return;
        }
        if (turn.stopReason === 'refusal') {
          const note = 'The model declined to answer this request.';
          emit({ event: 'text', data: { delta: note } });
          finalText = finalText ? `${finalText}\n${note}` : note;
          emit({ event: 'done', data: { message: finalText, toolCalls: calls } });
          return;
        }
        if (turn.stopReason === 'pause_turn') continue;
        if (turn.stopReason !== 'tool_use' || turn.toolCalls.length === 0) {
          emit({ event: 'done', data: { message: finalText, toolCalls: calls } });
          return;
        }
        const results: ToolResultTurn[] = [];
        for (const call of turn.toolCalls) {
          if (signal?.aborted) return;
          results.push(await this.execute(user, call, visible, searchMode, calls, emit));
        }
        turns.push({ role: 'tool_results', results });
      }
      const note = `Stopped after ${this.opts.maxIterations} tool iterations.`;
      emit({ event: 'text', data: { delta: note } });
      emit({ event: 'done', data: { message: finalText ? `${finalText}\n${note}` : note, toolCalls: calls } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: message, user: user.email }, 'chat loop failed');
      emit({ event: 'error', data: { message: `Chat failed: ${message}` } });
    }
  }

  private async execute(user: User, call: ModelToolCall, visible: PublicTool[], searchMode: boolean, calls: ToolCallSummary[], emit: (e: ChatEvent) => void): Promise<ToolResultTurn> {
    if (searchMode && call.name === SEARCH_TOOL) {
      const query = String(call.args.query ?? '');
      emit({ event: 'tool_call', data: { id: call.id, publicName: SEARCH_TOOL, serverSlug: 'gateway', toolName: SEARCH_TOOL, args: call.args } });
      const text = searchResultText(searchTools(visible, query));
      emit({ event: 'tool_result', data: { id: call.id, publicName: SEARCH_TOOL, outcome: 'success', durationMs: 0, preview: preview(text) } });
      return { id: call.id, name: SEARCH_TOOL, content: text, isError: false };
    }
    let publicName = call.name;
    let args: Record<string, unknown> = call.args;
    if (searchMode && call.name === CALL_TOOL) {
      publicName = String(call.args.name ?? '');
      args = toObject(call.args.arguments);
    }
    const known = visible.find((t) => t.publicName === publicName);
    emit({ event: 'tool_call', data: { id: call.id, publicName, serverSlug: known?.serverSlug ?? '', toolName: known?.name ?? publicName, args } });
    const started = performance.now();
    let outcome: string;
    let content: string;
    let isError: boolean;
    let durationMs: number;
    let serverSlug = known?.serverSlug ?? '';
    let toolName = known?.name ?? publicName;
    try {
      const r = await this.core.callTool(user, publicName, args, { source: 'chat' });
      outcome = r.outcome;
      durationMs = r.durationMs;
      serverSlug = r.serverSlug;
      toolName = r.toolName;
      content = resultToText(r.result);
      isError = !!r.result.isError;
    } catch (err) {
      durationMs = performance.now() - started;
      outcome = err instanceof ToolCallRejected ? err.outcome : 'error';
      content = err instanceof Error ? err.message.replace(/^MCP error -?\d+: /, '') : String(err);
      isError = true;
    }
    const p = preview(content);
    emit({ event: 'tool_result', data: { id: call.id, publicName, outcome, durationMs: Math.round(durationMs), preview: p } });
    calls.push({ id: call.id, publicName, serverSlug, toolName, args, outcome, durationMs: Math.round(durationMs), preview: p });
    return { id: call.id, name: publicName, content: content || '(empty result)', isError };
  }
}
