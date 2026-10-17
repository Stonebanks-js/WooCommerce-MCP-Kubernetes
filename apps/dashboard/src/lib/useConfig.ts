import { api } from '../api.js';
import type { AppConfig } from '../types.js';
import { useAsync, type AsyncState } from './useAsync.js';

let cached: Promise<AppConfig> | null = null;

/** GET /api/config is static for the life of the gateway process, so it is fetched once per page load. */
export function useConfig(): AsyncState<AppConfig> {
  return useAsync(() => {
    cached ??= api.config().catch((err: unknown) => {
      cached = null; // let the next mount retry
      throw err;
    });
    return cached;
  }, 'config');
}
