// Wire types for the gateway REST API. The interfaces under "contracts.md §9" are copied verbatim
// from the contract; everything else is derived from §9 / §11 prose.

// ---- contracts.md §9 -----------------------------------------------------------------------

export type ServerStatus = 'connected' | 'unreachable' | 'disabled';
export type MemberToolPolicy = { mode: 'all' } | { mode: 'allowlist' | 'denylist'; patterns: string[] }; // glob with *

export interface ServerInput {
  slug: string; name: string; url: string; enabled?: boolean;
  authType: 'none' | 'bearer' | 'header'; authHeaderName?: string; authSecret?: string;
  timeoutMs?: number; memberToolPolicy?: MemberToolPolicy;
}
export interface Server {               // never contains the secret
  id: string; slug: string; name: string; url?: string; enabled: boolean;
  authType: 'none' | 'bearer' | 'header'; authHeaderName?: string; hasCredential: boolean;
  timeoutMs: number; memberToolPolicy: MemberToolPolicy; managedBy: 'admin' | 'seed' | 'provisioner';
  status: ServerStatus; statusError?: string; statusCheckedAt?: string; toolsUpdatedAt?: string;
  tools: Array<{ name: string; publicName: string; title?: string; description?: string;
                 allowedForMembers: boolean; annotations?: Record<string, unknown> }>;
  createdAt: string; updatedAt: string;
}
export interface PublicTool { publicName: string; serverSlug: string; serverName: string; name: string;
  title?: string; description?: string; inputSchema: object; annotations?: object }
export interface ApiKey { id: string; userId: string; name: string; prefix: string; createdAt: string;
  lastUsedAt?: string; revokedAt?: string }
export interface AuditEntry { id: number; ts: string; userId?: string; userEmail: string; apiKeyId?: string;
  source: 'mcp' | 'chat'; serverId?: string; serverSlug?: string; toolName?: string; publicToolName: string;
  durationMs: number; outcome: string; errorMessage?: string; argsPreview?: string; resultBytes?: number }

// ---- derived from §9 prose -----------------------------------------------------------------

export type Role = 'admin' | 'member';
export type UserStatus = 'invited' | 'active' | 'disabled';
export type AuthType = ServerInput['authType'];
export type ServerTool = Server['tools'][number];

/** Users are serialised as {id,email,name,role,status,createdAt}. */
export interface User {
  id: string; email: string; name: string; role: Role; status: UserStatus; createdAt: string;
}

/** GET /api/config */
export interface AppConfig {
  publicUrl: string;
  mcpUrl: string;
  chat: { enabled: boolean; provider: string; model: string };
  version: string;
}

export type AuditSource = AuditEntry['source'];
/** audit_log.outcome check constraint (contracts.md §5). */
export const AUDIT_OUTCOMES = [
  'success', 'error', 'timeout', 'unreachable', 'denied', 'not_found', 'rate_limited',
] as const;

export interface AuditQuery {
  limit?: number; before?: number; userId?: string; serverId?: string; outcome?: string; source?: AuditSource;
}
export interface AuditPage { entries: AuditEntry[]; nextBefore: number | null }

export interface UserPatch { role?: Role; status?: 'active' | 'disabled'; name?: string }
export interface InviteInput { email: string; name?: string; role: Role }

// ---- contracts.md §11 (chat SSE) --------------------------------------------------------------

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface ChatStartData { model: string; provider: string; toolCount: number }
export interface ChatTextData { delta: string }
export interface ChatToolCallData { id: string; publicName: string; serverSlug: string; toolName: string; args: unknown }
export interface ChatToolResultData { id: string; publicName: string; outcome: string; durationMs: number; preview: string }
/** done.toolCalls is "the list of calls": the union of what tool_call and tool_result carried. */
export type ChatToolCallRecord = ChatToolCallData & Partial<Omit<ChatToolResultData, 'id' | 'publicName'>>;
export interface ChatDoneData { message: string; toolCalls: ChatToolCallRecord[] }
export interface ChatErrorData { message: string }

export type ChatEvent =
  | { type: 'start'; data: ChatStartData }
  | { type: 'text'; data: ChatTextData }
  | { type: 'tool_call'; data: ChatToolCallData }
  | { type: 'tool_result'; data: ChatToolResultData }
  | { type: 'done'; data: ChatDoneData }
  | { type: 'error'; data: ChatErrorData };
