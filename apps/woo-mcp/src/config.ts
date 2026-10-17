import { z } from 'zod';

/**
 * Environment contract for the WooCommerce MCP server (docs/contracts.md §12).
 *
 * Every variable is read from `process.env` exactly once at startup; nothing
 * else in the code base touches the environment, so tests can build a Config
 * by hand and point the server at a fake store.
 */

/** Treat empty strings as "unset" so `FOO=` in a manifest behaves like a missing key. */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

const stripTrailingSlashes = (s: string): string => s.replace(/\/+$/, '');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  WOO_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'WOO_BASE_URL must be an http(s) URL, e.g. http://demo-wordpress:80' })
    .transform(stripTrailingSlashes),
  WOO_USERNAME: z.string().min(1, 'WOO_USERNAME is required'),
  WOO_APP_PASSWORD: z.string().min(1, 'WOO_APP_PASSWORD is required'),
  MCP_AUTH_TOKEN: z.string().min(1, 'MCP_AUTH_TOKEN is required'),
  STORE_NAME: optionalString,
  STORE_URL: optionalString,
  WOO_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
  /** Comma-separated origins allowed to send an `Origin` header to /mcp (contracts §3). Default: none. */
  ALLOWED_ORIGINS: optionalString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type LogLevel = z.infer<typeof EnvSchema>['LOG_LEVEL'];

export interface Config {
  /** HTTP port for /healthz, /readyz and /mcp. */
  port: number;
  /** WordPress origin, no trailing slash, e.g. `http://demo-wordpress:80`. */
  wooBaseUrl: string;
  /** WordPress user that owns the application password (a shop_manager). */
  wooUsername: string;
  /** WordPress application password. Never logged, never returned. */
  wooAppPassword: string;
  /** Static bearer token the gateway presents on /mcp. */
  mcpAuthToken: string;
  /** Human-readable store name used in the server title and tool descriptions. */
  storeName: string;
  /** Public storefront URL used for permalinks; defaults to wooBaseUrl. */
  storeUrl: string;
  /** Per-request timeout for WooCommerce REST calls. */
  wooTimeoutMs: number;
  /**
   * Normalised origins (`scheme://host[:port]`, lower-case) that may send an
   * `Origin` header to /mcp. Empty (the default) rejects every request that
   * carries an Origin header with 403; requests without one are unaffected.
   */
  allowedOrigins: string[];
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parse `ALLOWED_ORIGINS` ("http://a, https://b:8443") into normalised origins. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const out = new Set<string>();
  const problems: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (!v) continue;
    let origin: string | undefined;
    try {
      const u = new URL(v);
      if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin.toLowerCase();
    } catch {
      origin = undefined;
    }
    if (origin === undefined || origin === 'null') {
      problems.push(`"${v}" is not an http(s) origin`);
    } else {
      out.add(origin);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  ALLOWED_ORIGINS: ${problems.join('; ')}`);
  }
  return [...out];
}

/** Parse the environment into a Config, throwing a ConfigError that lists every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${lines.join('\n  ')}`);
  }
  const e = parsed.data;
  const storeUrl = stripTrailingSlashes(e.STORE_URL ?? e.WOO_BASE_URL);
  if (!/^https?:\/\//i.test(storeUrl)) {
    throw new ConfigError('Invalid configuration:\n  STORE_URL: must be an http(s) URL');
  }
  return {
    port: e.PORT,
    wooBaseUrl: e.WOO_BASE_URL,
    wooUsername: e.WOO_USERNAME,
    wooAppPassword: e.WOO_APP_PASSWORD,
    mcpAuthToken: e.MCP_AUTH_TOKEN,
    storeName: e.STORE_NAME ?? 'WooCommerce store',
    storeUrl,
    wooTimeoutMs: e.WOO_TIMEOUT_MS,
    allowedOrigins: parseAllowedOrigins(e.ALLOWED_ORIGINS),
    logLevel: e.LOG_LEVEL,
  };
}
