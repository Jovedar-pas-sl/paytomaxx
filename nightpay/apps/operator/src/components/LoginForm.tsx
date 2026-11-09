'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, FormError, Input } from '@nightpay/ui';
import { BAD_CREDENTIALS_MESSAGE, LoginCodeRequiredError, login, loginWithCode, setSession, type OperatorUser } from '@/lib/api';

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
  // Con la 2FA activada, la contraseña da un ticket y falta el código de su app.
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const errorId = useId();
  // Email o contraseña mal escritos: se marcan los dos campos (no se sabe cuál de los dos).
  const fieldsWrong = error === BAD_CREDENTIALS_MESSAGE;
  const marked = fieldsWrong ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(email.trim().toLowerCase(), password);
      setSession(result);
      onSuccess(result.user);
    } catch (err) {
      if (err instanceof LoginCodeRequiredError) setTicket(err.loginTicket);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCode(e: FormEvent) {
    e.preventDefault();
    if (!ticket) return;
    setError(null);
    setBusy(true);
    try {
      const result = await loginWithCode(ticket, code);
      setSession(result);
      onSuccess(result.user);
    } catch (err) {
      setCode('');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (ticket) {
    return (
      <form onSubmit={handleCode} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
        <Input
          label="Código de tu app de verificación"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
          required
        />
        {error ? <FormError id={errorId}>{error}</FormError> : null}
        <Button type="submit" loading={busy} size="lg" disabled={code.length !== 6}>
          {submitLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setTicket(null);
            setCode('');
            setError(null);
          }}
        >
          Volver
        </Button>
      </form>
    );
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
        {...marked}
      />
      <Input
        label="Contraseña"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        {...marked}
      />
      {/* El error, encima del botón y a la vista (con icono), no una línea roja debajo. */}
      {error ? <FormError id={errorId}>{error}</FormError> : null}
      <Button type="submit" loading={busy} size="lg">
        {submitLabel}
      </Button>
    </form>
  );
}
