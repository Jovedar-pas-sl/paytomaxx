'use client';

import { useState, type FormEvent } from 'react';
import { Button, FormError, Input } from '@nightpay/ui';
import { LoginCodeRequiredError, login, loginWithCode, setSession } from '@/lib/api';

interface Props {
  onSuccess: () => void;
}

export function LoginForm({ onSuccess }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Con la 2FA activada, la contraseña da un ticket y falta el código de su app.
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = ticket ? await loginWithCode(ticket, code) : await login(email.trim().toLowerCase(), password);
      setSession(result);
      onSuccess();
    } catch (err) {
      if (err instanceof LoginCodeRequiredError) {
        setTicket(err.loginTicket);
      } else {
        setCode('');
        setError((err as Error).message);
      }
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
        maxWidth: '22rem',
      }}
    >
      {ticket ? (
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          placeholder="Código de tu app de verificación"
          aria-label="Código de tu app de verificación"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
          required
        />
      ) : (
        <>
          <Input
            type="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </>
      )}
      <Button type="submit" loading={busy} size="lg" disabled={ticket !== null && code.length !== 6}>
        Entrar
      </Button>
      {error ? <FormError>{error}</FormError> : null}
    </form>
  );
}
