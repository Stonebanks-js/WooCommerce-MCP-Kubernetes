import { useId, useState, type FormEvent } from 'react';
import { errorMessage } from '../../lib/errors.js';
import type { ApiKey } from '../../types.js';
import { Button } from '../../ui/Button.js';
import { CopyButton } from '../../ui/CopyButton.js';
import { ErrorNote, Field } from '../../ui/Field.js';
import { Modal } from '../../ui/Modal.js';

interface Props {
  title: string;
  /** Who the key is for, shown in the dialog (e.g. an email on the Team page). */
  subject?: string;
  issue: (name: string) => Promise<{ key: ApiKey; plaintext: string }>;
  onCreated: (key: ApiKey, plaintext: string) => void;
  onClose: () => void;
}

/** Name → create → show the plaintext exactly once (the gateway stores only its hash). */
export function NewKeyModal({ title, subject, issue, onCreated, onClose }: Props) {
  const formId = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: ApiKey; plaintext: string } | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await issue(name.trim());
      setCreated(result);
      onCreated(result.key, result.plaintext);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal open title="Copy your new key" onClose={onClose} width="md"
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="stack">
          <div className="notice">
            This is the only time the full key is shown. Store it somewhere safe; the gateway keeps only a hash.
          </div>
          <div className="key-reveal">
            <code className="code-block key-plain">{created.plaintext}</code>
            <CopyButton text={created.plaintext} size="md" variant="primary" label="Copy key" />
          </div>
          <div className="muted small">
            {created.key.name || 'Unnamed key'} · prefix <span className="mono">{created.key.prefix}</span>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open title={title} onClose={onClose} width="sm"
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>Create key</Button>
        </>
      )}>
      <form id={formId} onSubmit={onSubmit} className="stack" noValidate>
        {subject && <div className="muted">For <b>{subject}</b></div>}
        <Field label="Name" htmlFor="key-name" hint="Where this key will be used, e.g. “Claude Code on laptop”.">
          <input id="key-name" value={name} autoFocus maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorNote message={error} />
      </form>
    </Modal>
  );
}
