'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@nightpay/ui';
import { loginTotpSetup, loginWithNewCode, type LoginResponse, type LoginTotpSetup } from '@/lib/api';
import { ApiError, totpLockedUntil } from '@/lib/api-errors';
import { OTP_LENGTH } from '@/lib/otp';
import { isPngDataUrl } from '@/lib/urls';
import { useLockActive } from '@/lib/use-lock';
import { OtpInput } from './OtpInput';

interface Props {
  /** Ticket de la contraseña (401 TOTP_SETUP_REQUIRED). */
  ticket: string;
  onDone: (result: LoginResponse) => Promise<void>;
  /** Ticket caducado o ya usado: vuelta a la contraseña con este mensaje (estable: useCallback). */
  onExpired: (message: string) => void;
  onBack: () => void;
}

/**
 * Login de un super-admin sin 2FA: es obligatoria. Se activa aquí (QR y
 * código de la app) y con eso se entra; la contraseña ya la puso.
 */
export function LoginTotpEnroll({ ticket, onDone, onExpired, onBack }: Props) {
  const [setup, setSetup] = useState<LoginTotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);

  useEffect(() => {
    let alive = true;
    loginTotpSetup(ticket).then(
      (qr) => alive && setSetup(qr),
      (err: unknown) => {
        if (!alive) return;
        if (isTicketExpired(err)) onExpired((err as Error).message);
        else setError((err as Error).message);
      },
    );
    return () => {
      alive = false;
    };
  }, [ticket, onExpired]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (code.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');
    setError(null);
    setBusy(true);
    try {
      await onDone(await loginWithNewCode(ticket, code));
    } catch (err) {
      setCode('');
      setLockedUntil(totpLockedUntil(err, Date.now()));
      if (isTicketExpired(err)) return onExpired((err as Error).message);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} style={formStyle} noValidate>
      <p style={stepText}>
        Debes activar la verificación en dos pasos (2FA): es obligatoria para los super-admins. Escanea el QR con tu app
        de verificación (o escribe la clave) y pon el código que te enseña.
      </p>
      {setup && isPngDataUrl(setup.qrPngDataUrl) ? (
        <img src={setup.qrPngDataUrl} alt="Código QR para la app de verificación" width={200} height={200} style={qrStyle} />
      ) : null}
      {setup ? <code style={secretStyle}>{setup.secret}</code> : null}
      <OtpInput
        label="Código de tu app de verificación (2FA)"
        value={code}
        onChange={setCode}
        autoSubmit
        required
        lockedUntil={lockedUntil}
        disabled={busy || !setup}
        hint="Al poner el sexto número se activa y se entra. Cambia cada 30 s."
      />
      <Button type="submit" loading={busy} size="lg" disabled={!setup || locked || code.length !== OTP_LENGTH}>
        Activar y entrar
      </Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
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

function isTicketExpired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'LOGIN_TICKET_EXPIRED';
}

const formStyle = { display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' } as const;
const stepText = { margin: 0, fontSize: '1rem', color: 'var(--np-text-mute)', lineHeight: 1.5 } as const;
const qrStyle = { alignSelf: 'center', borderRadius: 8, background: '#fff', padding: 8 } as const;
const secretStyle = { alignSelf: 'center', fontSize: '0.875rem', letterSpacing: '0.08em', wordBreak: 'break-all' } as const;
const errorStyle = { color: 'var(--np-danger)', margin: 0, textAlign: 'center', fontSize: '0.875rem' } as const;
