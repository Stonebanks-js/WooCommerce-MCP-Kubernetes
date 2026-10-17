import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseEncryptionKey } from './crypto/secretbox.ts';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = z.preprocess(emptyToUndefined, z.string().optional());
const bool = (def: boolean) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()) : v),
    z.boolean().default(def),
  );
const int = (def: number, min = 0, max = 2_147_483_647) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

export const LLM_PROVIDERS = ['anthropic', 'openai_compatible', 'mock', 'none'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const envSchema = z.object({
  PORT: int(8080, 0, 65535),
  METRICS_PORT: int(9090, 0, 65535),
  DATABASE_URL: z.string().min(1),
  GATEWAY_ENCRYPTION_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  PUBLIC_URL: z.url(),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(8),
  DEMO_MEMBER_EMAIL: z.preprocess(emptyToUndefined, z.email().optional()),
  DEMO_MEMBER_PASSWORD: optStr,
  SEED_SERVERS_JSON: z.preprocess(emptyToUndefined, z.string().default('[]')),
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(LLM_PROVIDERS).default('none')),
  ANTHROPIC_API_KEY: optStr,
  LLM_MODEL: z.preprocess(emptyToUndefined, z.string().default('claude-opus-5-5')),
  LLM_BASE_URL: optStr,
  LLM_API_KEY: optStr,
  LLM_EFFORT: z.preprocess(emptyToUndefined, z.enum(['low', 'medium', 'high']).optional()),
  CHAT_MAX_ITERATIONS: int(8, 1, 100),
  CHAT_TOOL_SEARCH_THRESHOLD: int(40, 1, 10_000),
  HEALTH_INTERVAL_MS: int(15_000, 500),
  DEFAULT_TOOL_TIMEOUT_MS: int(30_000, 100),
  LIST_TOOLS_TIMEOUT_MS: int(10_000, 100),
  CONNECT_TIMEOUT_MS: int(5_000, 100),
  ALLOW_PRIVATE_UPSTREAMS: bool(false),
  ALLOWED_INTERNAL_SUFFIXES: z.preprocess(emptyToUndefined, z.string().default('.svc.cluster.local,.svc')),
  RATE_LIMIT_PER_MINUTE: int(120, 1),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(true),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.string().default('info')),
  CORS_ORIGIN: optStr,
  MCP_ALLOWED_ORIGINS: z.preprocess(emptyToUndefined, z.string().default('http://localhost:6274,http://127.0.0.1:6274')),
});

export interface Config {
  port: number;
  metricsPort: number;
  databaseUrl: string;
  encryptionKey: Buffer;
  sessionSecret: string;
  publicUrl: string;
  adminEmail: string;
  adminPassword: string;
  demoMemberEmail?: string;
  demoMemberPassword?: string;
  seedServersJson: string;
  llm: {
    provider: LlmProvider;
    model: string;
    anthropicApiKey?: string;
    baseUrl?: string;
    apiKey?: string;
    effort?: 'low' | 'medium' | 'high';
  };
  chatMaxIterations: number;
  chatToolSearchThreshold: number;
  healthIntervalMs: number;
  defaultToolTimeoutMs: number;
  listToolsTimeoutMs: number;
  connectTimeoutMs: number;
  allowPrivateUpstreams: boolean;
  allowedInternalSuffixes: string[];
  rateLimitPerMinute: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  logLevel: string;
  corsOrigin?: string;
  /** Extra origins allowed to send an `Origin` header to /mcp (browser-based MCP clients such as the Inspector UI). */
  mcpAllowedOrigins: string[];
  version: string;
}

export function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Parses the environment exactly as documented in contracts §7. Throws a readable error. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const llm: Config['llm'] = { provider: e.LLM_PROVIDER, model: e.LLM_MODEL };
  if (e.ANTHROPIC_API_KEY) llm.anthropicApiKey = e.ANTHROPIC_API_KEY;
  if (e.LLM_BASE_URL) llm.baseUrl = e.LLM_BASE_URL.replace(/\/+$/, '');
  if (e.LLM_API_KEY) llm.apiKey = e.LLM_API_KEY;
  if (e.LLM_EFFORT) llm.effort = e.LLM_EFFORT;
  if (llm.provider === 'anthropic' && !llm.anthropicApiKey) throw new Error('invalid configuration: ANTHROPIC_API_KEY is required for LLM_PROVIDER=anthropic');
  if (llm.provider === 'openai_compatible' && !llm.baseUrl) throw new Error('invalid configuration: LLM_BASE_URL is required for LLM_PROVIDER=openai_compatible');

  const cfg: Config = {
    port: e.PORT,
    metricsPort: e.METRICS_PORT,
    databaseUrl: e.DATABASE_URL,
    encryptionKey: parseEncryptionKey(e.GATEWAY_ENCRYPTION_KEY),
    sessionSecret: e.SESSION_SECRET,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    adminEmail: e.ADMIN_EMAIL.toLowerCase(),
    adminPassword: e.ADMIN_PASSWORD,
    seedServersJson: e.SEED_SERVERS_JSON,
    llm,
    chatMaxIterations: e.CHAT_MAX_ITERATIONS,
    chatToolSearchThreshold: e.CHAT_TOOL_SEARCH_THRESHOLD,
    healthIntervalMs: e.HEALTH_INTERVAL_MS,
    defaultToolTimeoutMs: e.DEFAULT_TOOL_TIMEOUT_MS,
    listToolsTimeoutMs: e.LIST_TOOLS_TIMEOUT_MS,
    connectTimeoutMs: e.CONNECT_TIMEOUT_MS,
    allowPrivateUpstreams: e.ALLOW_PRIVATE_UPSTREAMS,
    allowedInternalSuffixes: e.ALLOWED_INTERNAL_SUFFIXES.split(',').map((s) => s.trim()).filter(Boolean),
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    cookieSecure: e.COOKIE_SECURE,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    mcpAllowedOrigins: e.MCP_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    version: readPackageVersion(),
  };
  if (e.DEMO_MEMBER_EMAIL) cfg.demoMemberEmail = e.DEMO_MEMBER_EMAIL.toLowerCase();
  if (e.DEMO_MEMBER_PASSWORD) cfg.demoMemberPassword = e.DEMO_MEMBER_PASSWORD;
  if (e.CORS_ORIGIN) cfg.corsOrigin = e.CORS_ORIGIN;
  return cfg;
}
