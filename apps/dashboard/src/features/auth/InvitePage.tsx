import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import { Button } from '../../ui/Button.js';
import { ErrorNote, Field } from '../../ui/Field.js';
import { useAuth } from './AuthContext.js';
import { AuthCard } from './AuthCard.js';

const MIN_PASSWORD = 8;

export function InvitePage() {
  const { token = '' } = useParams();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm !== '' && confirm !== password;
  const tooShort = password !== '' && password.length < MIN_PASSWORD;
  const canSubmit = token !== '' && name.trim() !== '' && password.length >= MIN_PASSWORD && confirm === password;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.auth.acceptInvite(token, name.trim(), password);
      setUser(user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Accept your invitation" subtitle="Choose a display name and a password to activate your account.">
      {token === '' ? (
        <ErrorNote message="This invitation link is missing its token." />
      ) : (
        <form onSubmit={onSubmit} className="stack" noValidate>
          <Field label="Name" htmlFor="invite-name">
            <input id="invite-name" autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="invite-password" hint={`At least ${MIN_PASSWORD} characters.`}
            error={tooShort ? `Use at least ${MIN_PASSWORD} characters.` : null}>
            <input id="invite-password" type="password" autoComplete="new-password" required
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm password" htmlFor="invite-confirm" error={mismatch ? 'Passwords do not match.' : null}>
            <input id="invite-confirm" type="password" autoComplete="new-password" required
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <ErrorNote message={error} />
          <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>Activate account</Button>
        </form>
      )}
    </AuthCard>
  );
}
