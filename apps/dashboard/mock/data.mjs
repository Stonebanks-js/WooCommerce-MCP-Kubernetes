// Realistic in-memory fixtures for the mock gateway. Everything lives in process memory.
import { randomUUID } from 'node:crypto';

export const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
export const newId = () => randomUUID();

export const users = [
  { id: 'u-admin', email: 'admin@example.com', name: 'Ada Admin', role: 'admin', status: 'active', password: 'admin123', createdAt: iso(60 * 24 * 30) },
  { id: 'u-member', email: 'member@example.com', name: 'Max Member', role: 'member', status: 'active', password: 'member123', createdAt: iso(60 * 24 * 12) },
];

/** Raw MCP tools per server, mirroring contracts.md §12 / §13. */
const tool = (name, title, description, annotations) => ({ name, title, description, annotations, inputSchema: { type: 'object', properties: {} } });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
const DS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

export const servers = [
  {
    id: 's-woo', slug: 'woo', name: 'WooCommerce (demo store)',
    url: 'http://demo-woo-mcp.store-demo.svc.cluster.local:8080/mcp', enabled: true,
    authType: 'bearer', authHeaderName: undefined, hasCredential: true, timeoutMs: 30000,
    memberToolPolicy: { mode: 'allowlist', patterns: ['list_*', 'get_*'] }, managedBy: 'seed',
    status: 'connected', statusError: undefined, statusCheckedAt: iso(0.2), toolsUpdatedAt: iso(0.2),
    rawTools: [
      tool('list_products', 'List products', 'Search and page through the store catalogue.', RO),
      tool('get_product', 'Get product', 'Full summary of one product by id.', RO),
      tool('create_product', 'Create product', 'Create a simple product (name, regular_price, ...).', RW),
      tool('list_orders', 'List orders', 'Orders filtered by status and date range.', RO),
      tool('get_order', 'Get order', 'Full order incl. billing, shipping and line items.', RO),
      tool('update_order_status', 'Update order status', 'Transition an order (processing, completed, cancelled, ...).', DS),
    ],
    createdAt: iso(60 * 24 * 30), updatedAt: iso(60 * 24 * 2),
  },
  {
    id: 's-notes', slug: 'notes', name: 'Team notes',
    url: 'http://platform-mcp-notes.mcp-platform.svc.cluster.local:8080/mcp', enabled: true,
    authType: 'bearer', authHeaderName: undefined, hasCredential: true, timeoutMs: 15000,
    memberToolPolicy: { mode: 'all' }, managedBy: 'seed',
    status: 'unreachable', statusError: 'connect ECONNREFUSED 10.96.112.4:8080 (initialize timed out after 5000 ms)',
    statusCheckedAt: iso(0.25), toolsUpdatedAt: iso(60 * 3),
    rawTools: [
      tool('create_note', 'Create note', 'Create a note with a title, body and optional tags.', RW),
      tool('list_notes', 'List notes', 'List notes, optionally filtered by tag or search term.', RO),
      tool('get_note', 'Get note', 'Read one note by id.', RO),
      tool('delete_note', 'Delete note', 'Permanently delete a note.', DS),
      tool('get_current_time', 'Current time', 'Server time in ISO 8601 (collides with utils on purpose).', RO),
    ],
    createdAt: iso(60 * 24 * 30), updatedAt: iso(60 * 24 * 30),
  },
  {
    id: 's-utils', slug: 'utils', name: 'Utilities',
    url: 'http://platform-mcp-utils.mcp-platform.svc.cluster.local:8080/mcp', enabled: false,
    authType: 'header', authHeaderName: 'X-Api-Key', hasCredential: true, timeoutMs: 10000,
    memberToolPolicy: { mode: 'denylist', patterns: ['generate_*'] }, managedBy: 'admin',
    status: 'disabled', statusError: undefined, statusCheckedAt: iso(60 * 5), toolsUpdatedAt: iso(60 * 5),
    rawTools: [
      tool('get_current_time', 'Current time', 'Current time in a given IANA timezone.', RO),
      tool('calculate', 'Calculate', 'Evaluate a safe arithmetic expression.', RO),
      tool('convert_currency', 'Convert currency', 'Convert using a static rate table.', RO),
      tool('generate_uuid', 'Generate UUID', 'A random v4 UUID.', RO),
    ],
    createdAt: iso(60 * 24 * 9), updatedAt: iso(60 * 5),
  },
];

export const keys = [
  { id: 'k-1', userId: 'u-admin', name: 'Claude Code (laptop)', prefix: 'gw_7h3k9x2a', createdAt: iso(60 * 24 * 20), lastUsedAt: iso(3) },
  { id: 'k-2', userId: 'u-admin', name: 'MCP Inspector', prefix: 'gw_q1w2e3r4', createdAt: iso(60 * 24 * 5), lastUsedAt: undefined, revokedAt: iso(60 * 24) },
  { id: 'k-3', userId: 'u-member', name: 'Cursor', prefix: 'gw_m3mb3rk1', createdAt: iso(60 * 24 * 10), lastUsedAt: iso(42) },
];

export const sessions = new Map(); // sessionId -> userId
export const invites = new Map();  // token -> userId

/** Fake tools attached to servers created through the UI so the detail page has something to show. */
export const probeTools = [tool('ping', 'Ping', 'Round-trip check.', RO), tool('echo', 'Echo', 'Returns its input.', RO)];
