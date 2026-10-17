import type { Config } from '../../config.ts';
import type { ChatProvider } from '../types.ts';
import { AnthropicProvider } from './anthropic.ts';
import { MockProvider } from './mock.ts';
import { OpenAiCompatibleProvider } from './openaiCompatible.ts';

/** Returns null for `LLM_PROVIDER=none` (chat disabled). */
export function createProvider(cfg: Config['llm']): ChatProvider | null {
  switch (cfg.provider) {
    case 'none':
      return null;
    case 'mock':
      return new MockProvider(cfg.model);
    case 'anthropic': {
      const opts: ConstructorParameters<typeof AnthropicProvider>[0] = { apiKey: cfg.anthropicApiKey ?? '', model: cfg.model };
      if (cfg.effort) opts.effort = cfg.effort;
      return new AnthropicProvider(opts);
    }
    case 'openai_compatible': {
      const opts: ConstructorParameters<typeof OpenAiCompatibleProvider>[0] = { baseUrl: cfg.baseUrl ?? '', model: cfg.model };
      if (cfg.apiKey) opts.apiKey = cfg.apiKey;
      return new OpenAiCompatibleProvider(opts);
    }
  }
}
