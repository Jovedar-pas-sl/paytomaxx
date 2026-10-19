'use client';

import { useState, type FormEvent } from 'react';
import { Button, Input } from '@nightpay/ui';
import {
  LoginCodeRequiredError,
  discardLogin,
  login,
  loginWithCode,
  setSession,
  type LoginResponse,
  type User,
} from '@/lib/api';
import { ApiError, totpLockedUntil } from '@/lib/api-errors';
import { OTP_LENGTH } from '@/lib/otp';
import { useLockActive } from '@/lib/use-lock';
import { canUsePanel } from '@/lib/roles';
import { OtpInput } from './OtpInput';

interface Props {
  onSuccess: (user: User) => void;
}

/**
 * Entrar en el panel. Un super-admin con 2FA pone después el código de su app
 * (segundo paso): con él ya no se le vuelve a pedir al cambiar de local.
 */
export function LoginForm({ onSuccess }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Ticket del primer paso (contraseña buena): ahora falta el código. */
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);

  async function finish(result: LoginResponse): Promise<void> {
    // Camareros y chicas tienen sus apps: aquí todas las pestañas les darían 403.
    if (!canUsePanel(result.user.role)) {
      await discardLogin(result);
      setError('Esta cuenta no tiene acceso al panel. Entra con la cuenta del dueño o del encargado.');
      return;
    }
    setSession(result);
    onSuccess(result.user);
  }

  async function handlePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await finish(await login(email.trim().toLowerCase(), password));
    } catch (err) {
      if (err instanceof LoginCodeRequiredError) {
        setTicket(err.loginTicket);
        setCode('');
        setPassword('');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleCode(e: FormEvent) {
    e.preventDefault();
    if (!ticket || busy) return;
    if (code.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');
    setError(null);
    setBusy(true);
    try {
      await finish(await loginWithCode(ticket, code));
    } catch (err) {
      setCode('');
      setLockedUntil(totpLockedUntil(err, Date.now()));
      // Ticket caducado o ya usado: vuelta a la contraseña.
      if (err instanceof ApiError && err.code === 'LOGIN_TICKET_EXPIRED') setTicket(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (ticket) {
    return (
      <form onSubmit={(e) => void handleCode(e)} style={formStyle} noValidate>
        <p style={stepText}>
          Tu cuenta tiene la verificación en dos pasos. Pon el código de tu app para entrar en el panel.
        </p>
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={code}
          onChange={setCode}
          autoSubmit
          autoFocus
          required
          lockedUntil={lockedUntil}
          disabled={busy}
          hint="Al poner el sexto número se entra. Cambia cada 30 s."
        />
        <Button type="submit" loading={busy} size="lg" disabled={locked || code.length !== OTP_LENGTH}>
          Entrar
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setTicket(null);
            setError(null);
          }}
        >
          Volver
        </Button>
        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <form onSubmit={(e) => void handlePassword(e)} style={formStyle}>
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
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
    </form>
  );
}

const formStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  width: '100%',
} as const;

const stepText = { margin: 0, fontSize: '0.9375rem', color: 'var(--np-text-mute)', lineHeight: 1.5 } as const;

const errorStyle = {
  color: 'var(--np-danger)',
  margin: 0,
  textAlign: 'center',
  fontSize: '0.875rem',
} as const;
