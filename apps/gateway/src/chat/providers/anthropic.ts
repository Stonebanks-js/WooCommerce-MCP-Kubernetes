import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlockParam, BetaMessageParam, BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { toObject, type ChatProvider, type CompletionRequest, type ModelTurn, type StopReason, type Turn } from '../types.ts';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  effort?: 'low' | 'medium' | 'high';
}

function toMessages(turns: Turn[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const t of turns) {
    if (t.role === 'user') out.push({ role: 'user', content: t.content });
    else if (t.role === 'assistant') {
      if (Array.isArray(t.raw) && t.raw.length > 0) {
        // Echo the model's own blocks back unchanged: thinking blocks must precede tool_use on the
        // turn that carried it, and the signature must be intact (preserved thinking).
        out.push({ role: 'assistant', content: t.raw as BetaContentBlockParam[] });
        continue;
      }
      const content: BetaContentBlockParam[] = [];
      if (t.content) content.push({ type: 'text', text: t.content });
      for (const c of t.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      if (content.length === 0) content.push({ type: 'text', text: '(no content)' });
      out.push({ role: 'assistant', content });
    } else {
      out.push({
        role: 'user',
        content: t.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError })),
      });
    }
  }
  return out;
}

function mapStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause_turn';
    default:
      return 'other';
  }
}

/** Official SDK, beta Messages API with server-side fallback (the types of SDK 0.135 accept `betas`/`fallbacks`). */
export class AnthropicProvider implements ChatProvider {
  readonly provider = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: AnthropicProviderOptions['effort'];

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model;
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.effort = opts.effort;
  }

  async complete(req: CompletionRequest): Promise<ModelTurn> {
    const tools: BetaTool[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as BetaTool.InputSchema }));
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 8192,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // The system prompt + tool catalogue is the stable prefix; cache it across iterations and turns.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages: toMessages(req.turns),
      ...(this.effort ? { output_config: { effort: this.effort } } : {}),
    });
    const turn: ModelTurn = { text: '', toolCalls: [], stopReason: mapStop(res.stop_reason), raw: res.content };
    for (const block of res.content) {
      if (block.type === 'text') turn.text += block.text;
      else if (block.type === 'tool_use') turn.toolCalls.push({ id: block.id, name: block.name, args: toObject(block.input) });
    }
    if (turn.toolCalls.length > 0 && turn.stopReason !== 'tool_use') turn.stopReason = 'tool_use';
    return turn;
  }
}
