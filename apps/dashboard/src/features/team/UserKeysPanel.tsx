import { useState } from 'react';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import { useAsync } from '../../lib/useAsync.js';
import type { ApiKey, User } from '../../types.js';
import { Button } from '../../ui/Button.js';
import { useConfirm } from '../../ui/Confirm.js';
import { ErrorNote } from '../../ui/Field.js';
import { useToast } from '../../ui/Toast.js';
import { KeyTable } from '../keys/KeyTable.js';
import { NewKeyModal } from '../keys/NewKeyModal.js';

/** Admin view of one user's API keys: issue (plaintext shown once) and revoke. */
export function UserKeysPanel({ user }: { user: User }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, setData } = useAsync(() => api.users.keys(user.id), `user-keys:${user.id}`);
  const [issuing, setIssuing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const revoke = async (key: ApiKey) => {
    const ok = await confirm({
      title: 'Revoke API key',
      message: <>Revoke <b>{key.name || key.prefix}</b> belonging to {user.email}? Clients using it lose access immediately.</>,
      confirmLabel: 'Revoke', danger: true,
    });
    if (!ok) return;
    setBusyId(key.id);
    try {
      await api.keys.revoke(key.id);
      const revokedAt = new Date().toISOString();
      setData((d) => (d ? { keys: d.keys.map((k) => (k.id === key.id ? { ...k, revokedAt } : k)) } : d));
      toast.push('Key revoked', 'success');
    } catch (err) {
      toast.push(errorMessage(err), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="stack-tight">
      <div className="row-between">
        <div className="section-title" style={{ margin: 0 }}>API keys for {user.email}</div>
        <Button size="sm" variant="primary" onClick={() => setIssuing(true)} disabled={user.status === 'disabled'}>Issue key</Button>
      </div>
      <ErrorNote message={error} />
      <KeyTable keys={data?.keys ?? []} loading={loading} busyId={busyId} onRevoke={(k) => void revoke(k)}
        emptyHint="Issue a key here or let the user create one on their API keys page." />
      {issuing && (
        <NewKeyModal
          title="Issue API key"
          subject={user.email}
          issue={(name) => api.users.issueKey(user.id, name)}
          onCreated={(key) => setData((d) => ({ keys: [key, ...(d?.keys ?? [])] }))}
          onClose={() => setIssuing(false)}
        />
      )}
    </div>
  );
}
