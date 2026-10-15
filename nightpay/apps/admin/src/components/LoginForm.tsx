'use client';

import { useState, type FormEvent } from 'react';
import { Button, Input } from '@nightpay/ui';
import { discardLogin, login, setSession, type User } from '@/lib/api';
import { canUsePanel } from '@/lib/roles';

interface Props {
  onSuccess: (user: User) => void;
}

export function LoginForm({ onSuccess }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(email.trim().toLowerCase(), password);
      // Camareros y chicas tienen sus apps: aquí todas las pestañas les darían 403.
      if (!canUsePanel(result.user.role)) {
        await discardLogin(result);
        setError('Esta cuenta no tiene acceso al panel. Entra con la cuenta del dueño o del encargado.');
        return;
      }
      setSession(result);
      onSuccess(result.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        width: '100%',
      }}
    >
      <Input
        type="email"
        autoComplete="email"
        aria-label="Email"
        placeholder="email@nightpay.local"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Input
        type="password"
        autoComplete="current-password"
        aria-label="Contraseña"
        placeholder="contraseña"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <Button type="submit" loading={busy} size="lg">
        Entrar
      </Button>
      {error ? (
        <p
          role="alert"
          style={{
            color: 'var(--np-danger)',
            margin: 0,
            textAlign: 'center',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
