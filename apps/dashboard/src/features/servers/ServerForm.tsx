import type { AuthType, MemberToolPolicy, Server, ServerInput } from '../../types.js';
import { Field } from '../../ui/Field.js';
import { SLUG_PATTERN } from './status.js';

export interface ServerFormState {
  slug: string; name: string; url: string;
  authType: AuthType; authHeaderName: string; authSecret: string; clearSecret: boolean;
  timeoutMs: string; enabled: boolean;
  policyMode: MemberToolPolicy['mode']; patterns: string;
}
export type FormErrors = Partial<Record<keyof ServerFormState, string>>;

export function initialFormState(server: Server | null): ServerFormState {
  const policy = server?.memberToolPolicy ?? { mode: 'all' };
  return {
    slug: server?.slug ?? '', name: server?.name ?? '', url: server?.url ?? '',
    authType: server?.authType ?? 'none', authHeaderName: server?.authHeaderName ?? '', authSecret: '', clearSecret: false,
    timeoutMs: String(server?.timeoutMs ?? 30000), enabled: server?.enabled ?? true,
    policyMode: policy.mode, patterns: policy.mode === 'all' ? '' : policy.patterns.join('\n'),
  };
}

const splitPatterns = (text: string) => text.split('\n').map((p) => p.trim()).filter((p) => p !== '');

export function validateForm(s: ServerFormState): FormErrors {
  const errors: FormErrors = {};
  if (!SLUG_PATTERN.test(s.slug)) errors.slug = '2–20 chars: lowercase letter first, then letters, digits or dashes.';
  if (s.name.trim() === '') errors.name = 'Required.';
  if (!/^https?:\/\/\S+$/i.test(s.url.trim())) errors.url = 'Must be an http(s) URL, e.g. http://host:8080/mcp.';
  if (s.authType === 'header' && s.authHeaderName.trim() === '') errors.authHeaderName = 'Required for header auth.';
  const timeout = Number(s.timeoutMs);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600_000) errors.timeoutMs = 'Whole number between 1000 and 600000.';
  if (s.policyMode !== 'all' && splitPatterns(s.patterns).length === 0) errors.patterns = 'Add at least one pattern, one per line.';
  return errors;
}

/** Builds the request body; the secret is sent only when typed (or "" when clearing it), per §9. */
export function toServerInput(s: ServerFormState, existing: Server | null): ServerInput {
  const input: ServerInput = {
    slug: s.slug.trim(), name: s.name.trim(), url: s.url.trim(), enabled: s.enabled,
    authType: s.authType, timeoutMs: Number(s.timeoutMs),
    memberToolPolicy: s.policyMode === 'all' ? { mode: 'all' } : { mode: s.policyMode, patterns: splitPatterns(s.patterns) },
  };
  if (s.authType === 'header') input.authHeaderName = s.authHeaderName.trim();
  if (s.authType !== 'none') {
    if (existing && s.clearSecret) input.authSecret = '';
    else if (s.authSecret !== '') input.authSecret = s.authSecret;
  }
  return input;
}

interface FieldsProps {
  state: ServerFormState;
  errors: FormErrors;
  existing: Server | null;
  onChange: (patch: Partial<ServerFormState>) => void;
}

export function ServerFormFields({ state, errors, existing, onChange }: FieldsProps) {
  const secretHint = existing?.hasCredential
    ? 'Leave blank to keep the current credential.'
    : 'Stored encrypted; never shown again.';
  return (
    <div className="form-grid">
      <Field label="Slug" htmlFor="sv-slug" error={errors.slug} hint="Prefix of every public tool name (slug__tool).">
        <input id="sv-slug" className="mono" value={state.slug} disabled={existing !== null} autoFocus={existing === null}
          onChange={(e) => onChange({ slug: e.target.value })} placeholder="woo" />
      </Field>
      <Field label="Display name" htmlFor="sv-name" error={errors.name}>
        <input id="sv-name" value={state.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="WooCommerce (demo store)" />
      </Field>
      <div className="span-2">
        <Field label="URL" htmlFor="sv-url" error={errors.url} hint="Streamable HTTP endpoint of the upstream MCP server.">
          <input id="sv-url" className="mono" value={state.url} onChange={(e) => onChange({ url: e.target.value })}
            placeholder="http://demo-woo-mcp.store-demo.svc.cluster.local:8080/mcp" />
        </Field>
      </div>
      <Field label="Auth type" htmlFor="sv-auth">
        <select id="sv-auth" value={state.authType} onChange={(e) => onChange({ authType: e.target.value as AuthType })}>
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
        </select>
      </Field>
      {state.authType === 'header' ? (
        <Field label="Header name" htmlFor="sv-header" error={errors.authHeaderName}>
          <input id="sv-header" className="mono" value={state.authHeaderName} placeholder="X-Api-Key"
            onChange={(e) => onChange({ authHeaderName: e.target.value })} />
        </Field>
      ) : <div />}
      {state.authType !== 'none' && (
        <div className="span-2 stack-tight">
          <Field label="Secret" htmlFor="sv-secret" hint={secretHint}>
            <input id="sv-secret" type="password" autoComplete="new-password" value={state.authSecret} disabled={state.clearSecret}
              placeholder={existing?.hasCredential ? '••••••••  (leave blank to keep current)' : ''}
              onChange={(e) => onChange({ authSecret: e.target.value })} />
          </Field>
          {existing?.hasCredential && (
            <Field label="Clear the stored credential" htmlFor="sv-clear" inline>
              <input id="sv-clear" type="checkbox" checked={state.clearSecret} onChange={(e) => onChange({ clearSecret: e.target.checked, authSecret: '' })} />
            </Field>
          )}
        </div>
      )}
      <Field label="Timeout (ms)" htmlFor="sv-timeout" error={errors.timeoutMs}>
        <input id="sv-timeout" type="number" min={1000} max={600000} step={500} value={state.timeoutMs}
          onChange={(e) => onChange({ timeoutMs: e.target.value })} />
      </Field>
      <Field label="Enabled" htmlFor="sv-enabled" inline hint="Disabled servers contribute no tools.">
        <input id="sv-enabled" type="checkbox" checked={state.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
      </Field>
      <Field label="Member tool policy" htmlFor="sv-policy" hint="Admins always see every tool.">
        <select id="sv-policy" value={state.policyMode} onChange={(e) => onChange({ policyMode: e.target.value as MemberToolPolicy['mode'] })}>
          <option value="all">All tools</option>
          <option value="allowlist">Allowlist</option>
          <option value="denylist">Denylist</option>
        </select>
      </Field>
      {state.policyMode !== 'all' && (
        <Field label="Patterns" htmlFor="sv-patterns" error={errors.patterns} hint="One glob per line, matched against the upstream tool name (e.g. list_*).">
          <textarea id="sv-patterns" className="mono" rows={4} value={state.patterns} onChange={(e) => onChange({ patterns: e.target.value })} />
        </Field>
      )}
    </div>
  );
}
