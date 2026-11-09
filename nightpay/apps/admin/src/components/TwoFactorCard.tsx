'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import {
  confirmTotp,
  disableTotp,
  fetchTotpStatus,
  startTotpSetup,
  type TotpSetup,
} from '@/lib/api';
import { ApiError, isTotpUnreadable, totpLockedUntil } from '@/lib/api-errors';
import { isPngDataUrl } from '@/lib/urls';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';
import { Pill } from './Pill';

type Status = 'loading' | 'unavailable' | { enabled: boolean };

/**
 * Ajustes → Verificación en dos pasos: activar la app de verificación
 * (Google Authenticator, Authy…) para la cuenta que está dentro. Con ella,
 * los reembolsos de 100 € o más y los pagos a las chicas piden su código.
 * Activarla pide la contraseña actual (una sesión robada sola no puede).
 */
export function TwoFactorCard() {
  const [status, setStatus] = useState<Status>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  /** Pidiendo la contraseña antes del QR; se guarda para confirmar con el código. */
  const [askingPassword, setAskingPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** 429 del API (demasiados códigos malos): hasta cuándo no se puede probar otro. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    fetchTotpStatus()
      .then((s) => {
        if (!cancelled) setStatus({ enabled: s.enabled });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setStatus('unavailable');
        else setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function resetForm(): void {
    setCode('');
    setError(null);
    setCopied(false);
  }

  function cancelSetup(): void {
    setSetup(null);
    setAskingPassword(false);
    setPassword('');
    resetForm();
  }

  async function begin(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    resetForm();
    setDone(null);
    if (!password) return setError('Pon tu contraseña.');
    setBusy(true);
    try {
      setSetup(await startTotpSetup(password));
      setAskingPassword(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Ya estaba activada (otra pestaña, otro dispositivo).
        setStatus({ enabled: true });
        setAskingPassword(false);
        setPassword('');
        setDone('La verificación en dos pasos ya estaba activada.');
      } else {
        setError(codeErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent, action: 'confirm' | 'disable'): Promise<void> {
    e.preventDefault();
    // Se envía solo al completar el código: un Intro a la vez no lo repite.
    if (busy) return;
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError('El código son los 6 números que enseña la app ahora mismo.');
      return;
    }
    setBusy(true);
    try {
      const next = action === 'confirm' ? await confirmTotp(code, password) : await disableTotp(code);
      setStatus({ enabled: next.enabled });
      setSetup(null);
      setPassword('');
      resetForm();
      setDone(
        next.enabled
          ? 'Verificación en dos pasos activada. Desde ahora pedirá el código para reembolsos de 100 € o más y para pagar a las chicas.'
          : 'Verificación en dos pasos desactivada.',
      );
    } catch (err) {
      setCode('');
      setLockedUntil(totpLockedUntil(err, Date.now()));
      setError(codeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copySecret(secret: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setError('No se pudo copiar: escribe la clave a mano en la app.');
    }
  }

  return (
    <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={headerRow}>
        <h3 style={titleStyle}>Verificación en dos pasos</h3>
        {typeof status === 'object' ? (
          <Pill tone={status.enabled ? 'success' : 'neutral'}>{status.enabled ? 'Activada' : 'Desactivada'}</Pill>
        ) : null}
      </div>
      <p style={textStyle}>
        Pide un código de 6 números de una app de verificación (Google Authenticator, Authy…) para los reembolsos
        de 100 € o más y para pagar a las chicas. Así, una sesión robada no basta para mover dinero.
      </p>

      {done ? <Notice tone="success">{done}</Notice> : null}

      {loadError ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => setAttempt((n) => n + 1) }}>
          No se pudo saber si está activada: {loadError}
        </Notice>
      ) : status === 'loading' ? (
        <p style={textStyle}>Cargando…</p>
      ) : status === 'unavailable' ? (
        <Notice tone="info">El servidor todavía no permite activarla desde aquí.</Notice>
      ) : setup ? (
        <SetupSteps
          setup={setup}
          code={code}
          onCode={setCode}
          busy={busy}
          lockedUntil={lockedUntil}
          copied={copied}
          onCopy={() => void copySecret(setup.secret)}
          onSubmit={(e) => void submitCode(e, 'confirm')}
          onCancel={cancelSetup}
        />
      ) : askingPassword ? (
        <form onSubmit={(e) => void begin(e)} style={formStyle}>
          <Input
            label="Tu contraseña"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            hint="La de entrar en el panel: así nadie con tu sesión abierta la activa por ti."
          />
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button type="submit" loading={busy} disabled={!password}>
              Continuar
            </Button>
            <Button type="button" variant="ghost" onClick={cancelSetup} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : status.enabled ? (
        <form onSubmit={(e) => void submitCode(e, 'disable')} style={formStyle}>
          <OtpInput
            label="Para desactivarla, pon un código de tu app"
            value={code}
            onChange={setCode}
            autoSubmit
            lockedUntil={lockedUntil}
            hint="Se envía solo al poner el sexto número."
          />
          <Button type="submit" variant="danger" loading={busy} disabled={code.length !== 6}>
            Desactivar
          </Button>
        </form>
      ) : (
        <div>
          <Button
            onClick={() => {
              resetForm();
              setDone(null);
              setAskingPassword(true);
            }}
          >
            Activar
          </Button>
        </div>
      )}

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * 403 = código mal o ya usado (no se repite en 30 s); 429 = demasiados intentos
 * (el API dice los minutos); TOTP_UNREADABLE = el secreto guardado no se lee.
 */
function codeErrorMessage(err: unknown): string {
  const message = (err as Error).message;
  if (isTotpUnreadable(err) || isPasswordError(err)) return message;
  if (err instanceof ApiError && err.status === 429) {
    return /\d+\s*min/.test(message)
      ? message
      : 'Demasiados intentos con códigos incorrectos. Espera unos minutos y vuelve a probar.';
  }
  if (err instanceof ApiError && err.status === 403 && !message.includes('30 s')) {
    return `${message.replace(/\.$/, '')}. Si acabas de usar ese código, espera al siguiente (cambia cada 30 s).`;
  }
  return message;
}

/** La contraseña actual mal (403 PASSWORD_INVALID) o demasiadas veces (429 PASSWORD_LOCKED). */
function isPasswordError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'PASSWORD_INVALID' || err.code === 'PASSWORD_LOCKED');
}

function SetupSteps({
  setup,
  code,
  onCode,
  busy,
  lockedUntil,
  copied,
  onCopy,
  onSubmit,
  onCancel,
}: {
  setup: TotpSetup;
  code: string;
  onCode: (code: string) => void;
  busy: boolean;
  lockedUntil: number | null;
  copied: boolean;
  onCopy: () => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} style={formStyle}>
      <ol style={stepsStyle}>
        <li>Abre tu app de verificación y añade una cuenta escaneando este QR.</li>
        <li>¿No puedes escanearlo? Escribe en la app esta clave.</li>
        <li>Pon abajo el código de 6 números que te enseña la app.</li>
      </ol>
      {isPngDataUrl(setup.qrPngDataUrl) ? (
        <img
          src={setup.qrPngDataUrl}
          alt="Código QR para añadir la cuenta en la app de verificación"
          width={200}
          height={200}
          style={qrStyle}
        />
      ) : null}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <code style={secretStyle}>{setup.secret}</code>
        <Button type="button" variant="ghost" onClick={onCopy} size="sm">
          {copied ? 'Copiada' : 'Copiar clave'}
        </Button>
      </div>
      <OtpInput
        label="Código de la app"
        value={code}
        onChange={onCode}
        autoSubmit
        lockedUntil={lockedUntil}
        hint="Se envía solo al poner el sexto número."
      />
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Button type="submit" loading={busy} disabled={code.length !== 6}>
          Confirmar y activar
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

const headerRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' };

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-h4)',
  fontWeight: 600,
};

const textStyle: CSSProperties = { margin: 0, fontSize: '0.85rem', lineHeight: 1.5, color: 'var(--np-text-mute)' };

const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.875rem' };

const stepsStyle: CSSProperties = {
  margin: 0,
  paddingLeft: '1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
};

const qrStyle: CSSProperties = {
  alignSelf: 'flex-start',
  background: '#fff',
  padding: '0.5rem',
  borderRadius: 'var(--np-r-md)',
};

const secretStyle: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.85rem',
  letterSpacing: '0.08em',
  padding: '0.4rem 0.6rem',
  background: 'var(--np-surface-2)',
  borderRadius: '0.3rem',
  wordBreak: 'break-all',
};

