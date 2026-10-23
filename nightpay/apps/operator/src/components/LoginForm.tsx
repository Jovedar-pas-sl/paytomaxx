'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, FormError, Input } from '@nightpay/ui';
import { BAD_CREDENTIALS_MESSAGE, login, setSession, type OperatorUser } from '@/lib/api';

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
