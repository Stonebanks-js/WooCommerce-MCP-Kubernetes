import { useId, useState, type FormEvent } from 'react';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import type { Server } from '../../types.js';
import { StatusBadge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { ErrorNote } from '../../ui/Field.js';
import { Modal } from '../../ui/Modal.js';
import { initialFormState, ServerFormFields, toServerInput, validateForm, type FormErrors } from './ServerForm.js';

interface Props {
  /** null = create a new server. Mount with a key per server so the form state resets. */
  server: Server | null;
  onClose: () => void;
  onSaved: (server: Server, created: boolean) => void;
}

/** Add / edit dialog. After saving it shows the probe result the backend returned (§9: POST probes once). */
export function ServerFormModal({ server, onClose, onSaved }: Props) {
  const formId = useId();
  const [state, setState] = useState(() => initialFormState(server));
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Server | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validateForm(state);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const input = toServerInput(state, server);
      const { server: saved } = server ? await api.servers.update(server.id, input) : await api.servers.create(input);
      setResult(saved);
      onSaved(saved, server === null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal open title={server ? 'Server updated' : 'Server added'} onClose={onClose} width="sm"
        footer={<Button variant="primary" onClick={onClose} autoFocus>Done</Button>}>
        <div className="save-result">
          <div className="row">
            <b>{result.name}</b>
            <span className="server-slug">{result.slug}</span>
            <StatusBadge status={result.status} error={result.statusError} />
          </div>
          {result.status === 'connected' && (
            <div className="muted">Probe succeeded: {result.tools.length} tool{result.tools.length === 1 ? '' : 's'} listed.</div>
          )}
          {result.status === 'unreachable' && (
            <ErrorNote message={result.statusError ?? 'The gateway could not reach this server.'} />
          )}
          {result.status === 'disabled' && <div className="muted">Saved as disabled; it contributes no tools until enabled.</div>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal open title={server ? `Edit ${server.name}` : 'Add server'} onClose={onClose} width="lg"
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>
            {server ? 'Save changes' : 'Add and probe'}
          </Button>
        </>
      )}>
      <form id={formId} onSubmit={onSubmit} className="stack" noValidate>
        <ServerFormFields state={state} errors={errors} existing={server} onChange={(patch) => setState((s) => ({ ...s, ...patch }))} />
        <ErrorNote message={error} />
      </form>
    </Modal>
  );
}
