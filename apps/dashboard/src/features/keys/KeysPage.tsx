import { useState } from 'react';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import { useAsync } from '../../lib/useAsync.js';
import { useConfig } from '../../lib/useConfig.js';
import type { ApiKey } from '../../types.js';
import { Button } from '../../ui/Button.js';
import { useConfirm } from '../../ui/Confirm.js';
import { ErrorNote } from '../../ui/Field.js';
import { useToast } from '../../ui/Toast.js';
import { PageHeader } from '../layout/PageHeader.js';
import { ConnectPanel } from './ConnectPanel.js';
import { KeyTable } from './KeyTable.js';
import { NewKeyModal } from './NewKeyModal.js';
import './keys.css';

export function KeysPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const config = useConfig();
  const { data, error, loading, setData } = useAsync(() => api.keys.list(), 'keys');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The key created on this page visit, so the connect snippets can be filled in until it is revoked. */
  const [freshKey, setFreshKey] = useState<{ id: string; plaintext: string } | null>(null);
  const keys = data?.keys ?? [];

  const revoke = async (key: ApiKey) => {
    const ok = await confirm({
      title: 'Revoke API key',
      message: <>Revoke <b>{key.name || key.prefix}</b>? Clients using it lose access immediately. This cannot be undone.</>,
      confirmLabel: 'Revoke', danger: true,
    });
    if (!ok) return;
    setBusyId(key.id);
    try {
      await api.keys.revoke(key.id);
      const revokedAt = new Date().toISOString();
      setData((d) => (d ? { keys: d.keys.map((k) => (k.id === key.id ? { ...k, revokedAt } : k)) } : d));
      setFreshKey((fresh) => (fresh?.id === key.id ? null : fresh));
      toast.push('Key revoked', 'success');
    } catch (err) {
      toast.push(errorMessage(err), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="API keys"
        subtitle="Keys authenticate MCP clients (Claude Code, Cursor, Inspector) against the gateway as you."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Create key</Button>}
      />
      <ErrorNote message={error} />
      <KeyTable keys={keys} loading={loading} busyId={busyId} onRevoke={(k) => void revoke(k)}
        emptyHint="Create a key, then paste it into one of the client snippets below." />
      <div className="section">
        {config.data ? (
          <ConnectPanel mcpUrl={config.data.mcpUrl} keyPlaintext={freshKey?.plaintext ?? null} />
        ) : (
          <ErrorNote message={config.error} />
        )}
      </div>
      {creating && (
        <NewKeyModal
          title="Create API key"
          issue={(name) => api.keys.create(name)}
          onCreated={(key, plaintext) => {
            setData((d) => ({ keys: [key, ...(d?.keys ?? [])] }));
            setFreshKey({ id: key.id, plaintext });
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
