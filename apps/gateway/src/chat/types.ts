/** Provider-neutral tool definition given to the model (name = public tool name). */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultTurn {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/** Provider-neutral transcript; each provider converts it to its own wire format. */
export type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ModelToolCall[]; /** Provider-opaque content blocks of this turn, replayed verbatim (thinking blocks etc.). */ raw?: unknown }
  | { role: 'tool_results'; results: ToolResultTurn[] };

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

export interface ModelTurn {
  text: string;
  toolCalls: ModelToolCall[];
  stopReason: StopReason;
  /** The provider's own content blocks for this turn, if it needs them echoed back unchanged. */
  raw?: unknown;
}

export interface CompletionRequest {
  system: string;
  turns: Turn[];
  tools: ToolDef[];
}

export interface ChatProvider {
  readonly provider: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<ModelTurn>;
}

export interface ChatInputMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** SSE events exactly as in contracts §11. */
export type ChatEvent =
  | { event: 'start'; data: { model: string; provider: string; toolCount: number } }
  | { event: 'text'; data: { delta: string } }
  | { event: 'tool_call'; data: { id: string; publicName: string; serverSlug: string; toolName: string; args: unknown } }
  | { event: 'tool_result'; data: { id: string; publicName: string; outcome: string; durationMs: number; preview: string } }
  | { event: 'done'; data: { message: string; toolCalls: ToolCallSummary[] } }
  | { event: 'error'; data: { message: string } };

export interface ToolCallSummary {
  id: string;
  publicName: string;
  serverSlug: string;
  toolName: string;
  args: unknown;
  outcome: string;
  durationMs: number;
  preview: string;
}

export const PREVIEW_MAX = 500;
export const TOOL_RESULT_MAX_BYTES = 16 * 1024;

export function toObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
