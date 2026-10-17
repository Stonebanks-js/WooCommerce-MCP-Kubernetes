import { useId, useState, type FormEvent } from 'react';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import type { Role, User } from '../../types.js';
import { Button } from '../../ui/Button.js';
import { CopyButton } from '../../ui/CopyButton.js';
import { ErrorNote, Field } from '../../ui/Field.js';
import { Modal } from '../../ui/Modal.js';

interface Props {
  onInvited: (user: User) => void;
  onClose: () => void;
}

export function InviteModal({ onInvited, onClose }: Props) {
  const formId = useId();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.users.invite({ email: email.trim().toLowerCase(), name: name.trim() || undefined, role });
      setInviteUrl(result.inviteUrl);
      onInvited(result.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (inviteUrl) {
    return (
      <Modal open title="Invitation created" onClose={onClose} width="md"
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="stack">
          <div className="notice">Send this link to {email}. It works once and expires in 7 days; it is not shown again.</div>
          <div className="key-reveal">
            <code className="code-block key-plain">{inviteUrl}</code>
            <CopyButton text={inviteUrl} size="md" variant="primary" label="Copy link" />
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open title="Invite a teammate" onClose={onClose} width="sm"
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} disabled={email.trim() === ''}>Create invite</Button>
        </>
      )}>
      <form id={formId} onSubmit={onSubmit} className="stack" noValidate>
        <Field label="Email" htmlFor="inv-email">
          <input id="inv-email" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Name" htmlFor="inv-name" hint="Optional; they can set it when accepting.">
          <input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role" htmlFor="inv-role" hint="Members see only tools allowed by each server's policy.">
          <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <ErrorNote message={error} />
      </form>
    </Modal>
  );
}
