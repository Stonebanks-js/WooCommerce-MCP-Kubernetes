import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import { Button } from '../../ui/Button.js';
import { ErrorNote, Field } from '../../ui/Field.js';
import { useAuth, useReturnPath } from './AuthContext.js';
import { AuthCard } from './AuthCard.js';

export function LoginPage() {
  const { user, loading, setUser } = useAuth();
  const navigate = useNavigate();
  const returnPath = useReturnPath();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && user) return <Navigate to={returnPath} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user: signedIn } = await api.auth.login(email.trim(), password);
      setUser(signedIn);
      navigate(returnPath, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in" subtitle="Use the account an administrator created for you.">
      <form onSubmit={onSubmit} className="stack" noValidate>
        <Field label="Email" htmlFor="login-email">
          <input id="login-email" type="email" autoComplete="username" required autoFocus
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="login-password">
          <input id="login-password" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorNote message={error} />
        <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>Sign in</Button>
      </form>
    </AuthCard>
  );
}
