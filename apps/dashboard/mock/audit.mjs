// 60 generated audit rows (newest first) with every outcome of contracts.md §5.
import { iso, servers, users } from './data.mjs';

const OUTCOMES = ['success', 'success', 'success', 'success', 'success', 'error', 'timeout', 'unreachable', 'denied', 'not_found', 'rate_limited'];
const ERRORS = {
  error: 'Upstream returned isError: WooCommerce 404 for order 99120',
  timeout: 'Upstream "woo" timed out after 30000 ms',
  unreachable: 'Upstream "notes" is unreachable: connect ECONNREFUSED 10.96.112.4:8080',
  denied: 'Tool not permitted for your role',
  not_found: 'Unknown tool: woo__refund_order',
  rate_limited: 'Rate limit exceeded',
};
const CALLS = [
  ['woo', 'list_orders', '{"status":"processing","per_page":5}'], ['woo', 'get_order', '{"id":1042}'],
  ['woo', 'list_products', '{"search":"mug"}'], ['notes', 'list_notes', '{"tag":"ops"}'],
  ['notes', 'get_current_time', '{}'], ['utils', 'calculate', '{"expression":"12*7"}'],
  ['woo', 'update_order_status', '{"id":1042,"status":"completed"}'], ['utils', 'convert_currency', '{"amount":120,"from":"USD","to":"EUR"}'],
];

export const audit = [];
for (let i = 0; i < 60; i++) {
  const [slug, toolName, args] = CALLS[i % CALLS.length];
  const outcome = OUTCOMES[(i * 7) % OUTCOMES.length];
  const user = users[i % 3 === 0 ? 1 : 0];
  const serverId = servers.find((s) => s.slug === slug).id;
  audit.push({
    id: 1059 - i, ts: iso(i * 11 + (i % 4)), userId: user.id, userEmail: user.email, // newer rows have higher ids
    apiKeyId: i % 2 === 0 ? (user.id === 'u-admin' ? 'k-1' : 'k-3') : undefined,
    source: i % 2 === 0 ? 'mcp' : 'chat', serverId, serverSlug: slug, toolName,
    publicToolName: `${slug}__${toolName}`,
    durationMs: outcome === 'timeout' ? 30000 : 40 + ((i * 97) % 900),
    outcome, errorMessage: ERRORS[outcome], argsPreview: args,
    resultBytes: outcome === 'success' ? 200 + ((i * 131) % 4000) : undefined,
  });
}
audit.sort((a, b) => b.id - a.id);
