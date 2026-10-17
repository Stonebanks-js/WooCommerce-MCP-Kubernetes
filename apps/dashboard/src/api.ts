// Typed client for every endpoint of contracts.md section 9 plus the SSE chat stream of section 11.
// Every call sends the gw_session cookie (credentials: 'include'); errors are surfaced as ApiError
// carrying the {error, message} body; a 401 on any session route invokes the unauthorized handler
// installed by the auth provider, which sends the user to /login and remembers where they were.

import { readSseStream } from './sse.js';
import type {
  ApiKey, AppConfig, AuditPage, AuditQuery, ChatEvent, ChatMessage, InviteInput, PublicTool, Server,
  ServerInput, User, UserPatch,
} from './types.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;
/** Installed once by the auth provider; called after any unexpected 401. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

type Query = Record<string, string | number | undefined>;
interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** Routes where 401 means "bad credentials" rather than "session expired". */
  allowUnauthorized?: boolean;
  signal?: AbortSignal;
}

function isErrorBody(value: unknown): value is { error: string; message: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as { error?: unknown }).error === 'string'
    && typeof (value as { message?: unknown }).message === 'string';
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let code = `http_${res.status}`;
  let message = res.statusText ? `${res.status} ${res.statusText}` : `Request failed with status ${res.status}`;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isErrorBody(parsed)) {
      code = parsed.error;
      message = parsed.message;
    }
  } catch {
    if (text.trim() !== '') message = text.trim().slice(0, 200);
  }
  return new ApiError(res.status, code, message);
}

function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function send(path: string, opts: RequestOptions, accept: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the gateway. Is it running?');
  }
  if (!res.ok) {
    const error = await errorFromResponse(res);
    if (res.status === 401 && !opts.allowUnauthorized) onUnauthorized?.();
    throw error;
  }
  return res;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts, 'application/json');
  return (await res.json()) as T;
}

const CHAT_EVENT_TYPES: ReadonlySet<string> = new Set(['start', 'text', 'tool_call', 'tool_result', 'done', 'error']);

async function* chatStream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<ChatEvent, void, undefined> {
  const res = await send('/api/chat', { method: 'POST', body: { messages }, signal }, 'text/event-stream');
  if (!res.body) throw new ApiError(res.status, 'empty_stream', 'The chat endpoint returned no stream');
  for await (const ev of readSseStream(res.body, signal)) {
    if (!CHAT_EVENT_TYPES.has(ev.event)) continue; // forward-compatible: ignore unknown events
    let data: unknown;
    try {
      data = JSON.parse(ev.data);
    } catch {
      throw new ApiError(res.status, 'bad_event', `Malformed "${ev.event}" event from the chat stream`);
    }
    // The contract fixes the payload per event type; the shape is trusted after the JSON parse.
    yield { type: ev.event, data } as ChatEvent;
  }
}

const id = (value: string) => encodeURIComponent(value);

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<{ user: User }>('/api/auth/login', { method: 'POST', body: { email, password }, allowUnauthorized: true }),
    logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST', allowUnauthorized: true }),
    me: () => request<{ user: User }>('/api/auth/me', { allowUnauthorized: true }),
    acceptInvite: (token: string, name: string, password: string) =>
      request<{ user: User }>('/api/auth/accept-invite', {
        method: 'POST', body: { token, name, password }, allowUnauthorized: true,
      }),
  },
  config: () => request<AppConfig>('/api/config', { allowUnauthorized: true }),
  servers: {
    list: () => request<{ servers: Server[] }>('/api/servers'),
    create: (input: ServerInput) => request<{ server: Server }>('/api/servers', { method: 'POST', body: input }),
    get: (serverId: string) => request<{ server: Server }>(`/api/servers/${id(serverId)}`),
    update: (serverId: string, patch: Partial<ServerInput>) =>
      request<{ server: Server }>(`/api/servers/${id(serverId)}`, { method: 'PATCH', body: patch }),
    remove: (serverId: string) => request<{ ok: true }>(`/api/servers/${id(serverId)}`, { method: 'DELETE' }),
    refresh: (serverId: string) => request<{ server: Server }>(`/api/servers/${id(serverId)}/refresh`, { method: 'POST' }),
  },
  tools: {
    list: () => request<{ tools: PublicTool[] }>('/api/tools'),
  },
  users: {
    list: () => request<{ users: User[] }>('/api/users'),
    invite: (input: InviteInput) =>
      request<{ user: User; inviteUrl: string }>('/api/users/invite', { method: 'POST', body: input }),
    update: (userId: string, patch: UserPatch) =>
      request<{ user: User }>(`/api/users/${id(userId)}`, { method: 'PATCH', body: patch }),
    remove: (userId: string) => request<{ ok: true }>(`/api/users/${id(userId)}`, { method: 'DELETE' }),
    keys: (userId: string) => request<{ keys: ApiKey[] }>(`/api/users/${id(userId)}/keys`),
    issueKey: (userId: string, name: string) =>
      request<{ key: ApiKey; plaintext: string }>(`/api/users/${id(userId)}/keys`, { method: 'POST', body: { name } }),
  },
  keys: {
    list: () => request<{ keys: ApiKey[] }>('/api/keys'),
    create: (name: string) => request<{ key: ApiKey; plaintext: string }>('/api/keys', { method: 'POST', body: { name } }),
    revoke: (keyId: string) => request<{ ok: true }>(`/api/keys/${id(keyId)}`, { method: 'DELETE' }),
  },
  audit: {
    list: (query: AuditQuery) => request<AuditPage>('/api/audit', { query: { ...query } }),
  },
  chat: {
    stream: chatStream,
  },
};
