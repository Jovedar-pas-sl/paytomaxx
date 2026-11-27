'use client';

import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react';
import { passkeysSupported, type CreationOptionsJSON } from '@nightpay/api-client';
import { unlockName, type StaffPasskeyView } from '@nightpay/contracts';
import { Button, EmptyState, FormError, Input, Sheet } from '@nightpay/ui';
import { fetchPasskeys, fetchStepUp, passkeyRegister, passkeyRegistrationOptions, removePasskey, stepUpErrorText } from '../lib/api-step-up';

/**
 * «Llave de acceso» (desde el menú): quien no tiene la verificación en dos
 * pasos confirma con su móvil (Face ID, huella o el PIN del propio móvil)
 * para ver lo delicado de sus cobros. Darla de alta pide la contraseña otra
 * vez (y el código, si tiene 2FA); después, un toque crea la llave (en el
 * iPhone tiene que ser en el mismo toque).
 */
export function PasskeySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const unlock = unlockName(typeof navigator === 'undefined' ? null : navigator.userAgent);
  const [keys, setKeys] = useState<StaffPasskeyView[] | null>(null);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [options, setOptions] = useState<CreationOptionsJSON | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const supported = passkeysSupported();
  const formId = useId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    Promise.all([fetchPasskeys(), fetchStepUp()])
      .then(([list, status]) => {
        if (cancelled) return;
        setKeys(list);
        setTotpEnabled(status.totpEnabled);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(stepUpErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  function close(): void {
    setPassword('');
    setCode('');
    setOptions(null);
    setError(null);
    setDone(false);
    onClose();
  }

  async function begin(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (!password) return setError('Pon tu contraseña.');
    if (totpEnabled && !/^\d{6}$/.test(code)) return setError('Pon el código de 6 cifras de tu app de verificación.');
    setBusy(true);
    setError(null);
    try {
      setOptions(await passkeyRegistrationOptions(password, totpEnabled ? code : undefined));
      setPassword('');
      setCode('');
    } catch (err) {
      setError(stepUpErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    if (busy || !options) return;
    setBusy(true);
    setError(null);
    try {
      await passkeyRegister(options);
      setOptions(null);
      setDone(true);
      setAttempt((n) => n + 1);
    } catch (err) {
      const text = stepUpErrorText(err);
      if (text) {
        setError(text);
        setOptions(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removePasskey(id);
      setAttempt((n) => n + 1);
    } catch (err) {
      setError(stepUpErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Llave de acceso"
      footer={
        !supported ? undefined : options ? (
          <Button onClick={() => void create()} loading={busy}>
            Crear la llave con {unlock}
          </Button>
        ) : (
          <Button type="submit" form={formId} loading={busy}>
            Añadir una llave en este móvil
          </Button>
        )
      }
    >
      <div style={stack}>
        <p style={note}>
          Confirma con tu móvil (Face ID o huella) para ver lo delicado de tus cobros, si no usas la verificación en dos pasos.
        </p>
        {keys?.map((k) => (
          <div key={k.id} style={row}>
            <span>
              <b style={{ fontWeight: 600 }}>{k.label}</b>
              <span style={{ ...note, display: 'block' }}>{k.lastUsedAt ? 'Ya la has usado' : 'Aún sin usar'}</span>
            </span>
            <Button variant="ghost" onClick={() => void remove(k.id)} disabled={busy}>
              Quitar
            </Button>
          </div>
        ))}
        {keys?.length === 0 ? <EmptyState compact icon="lock" title="Aún no tienes ninguna llave." /> : null}
        {done ? <p style={{ margin: 0 }}>Llave creada. Ya puedes confirmar con este móvil.</p> : null}
        {!supported ? <p style={{ margin: 0 }}>Este navegador no permite llaves de acceso.</p> : null}
        {supported && !options ? (
          <form id={formId} onSubmit={(e) => void begin(e)} style={stack}>
            <Input label="Tu contraseña" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {totpEnabled ? (
              <Input
                label="Código de tu app de verificación"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            ) : null}
          </form>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}
      </div>
    </Sheet>
  );
}

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' };
const note: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', lineHeight: 1.45, color: 'var(--np-text-mute)' };
