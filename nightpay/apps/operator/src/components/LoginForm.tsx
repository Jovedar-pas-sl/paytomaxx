'use client';

import { useState, type FormEvent } from 'react';
import { Button, Input } from '@nightpay/ui';
import { login, setSession, type OperatorUser } from '@/lib/api';

interface Props {
  onSuccess: (user: OperatorUser) => void;
  /** Volver a entrar: el email de quien estaba (se puede cambiar). */
  initialEmail?: string;
  submitLabel?: string;
}

export function LoginForm({ onSuccess, initialEmail = '', submitLabel = 'Entrar' }: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(email.trim().toLowerCase(), password);
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
      style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}
    >
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="tu@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Input
        label="Contraseña"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <Button type="submit" loading={busy} size="lg">
        {submitLabel}
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
