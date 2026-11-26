'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { passkeysSupported, type CreationOptionsJSON } from '@nightpay/api-client';
import { unlockName, type StaffPasskeyView } from '@nightpay/contracts';
import { Button, FormError, Input } from '@nightpay/ui';
import { fetchPasskeys, fetchStepUp, passkeyRegister, passkeyRegistrationOptions, removePasskey } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { stepUpErrorText } from '@/lib/step-up';
import { OtpInput } from '../OtpInput';
import { SettingsCard } from './SettingsBits';

/**
 * Ajustes → Seguridad → «Llave de acceso»: quien no tiene la verificación en
 * dos pasos se verifica con su móvil (Face ID o huella) para ver lo delicado de un cobro y para anular o devolver. Darla de
 * alta pide la contraseña otra vez (y el código, si tiene 2FA); después, un
 * toque en el móvil crea la llave (en el iPhone tiene que ser en el mismo toque).
 */
export function PasskeysCard() {
  const unlock = unlockName(typeof navigator === 'undefined' ? null : navigator.userAgent);
  const [keys, setKeys] = useState<StaffPasskeyView[] | null>(null);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [options, setOptions] = useState<CreationOptionsJSON | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const supported = passkeysSupported();

  useEffect(() => {
    let cancelled = false;
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
  }, [attempt]);

  function reset(): void {
    setAdding(false);
    setPassword('');
    setCode('');
    setOptions(null);
    setError(null);
  }

  async function begin(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (!password) return setError('Pon tu contraseña.');
    if (totpEnabled && code.length !== 6) return setError('Pon el código de tu app de verificación.');
    setBusy(true);
    setError(null);
    try {
      setOptions(await passkeyRegistrationOptions(password, totpEnabled ? code : undefined));
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
      reset();
      setAttempt((n) => n + 1);
    } catch (err) {
      const text = stepUpErrorText(err);
      // Canceló en el móvil: puede volver a tocar (el alta sigue unos minutos).
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
    <SettingsCard
      title="Llave de acceso" tour="seguridad-llave"
      hint="Si no usas la verificación en dos pasos, confirma con tu móvil (Face ID o huella) para ver lo delicado de un cobro y para anular o devolver."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {keys === null && !error ? <p style={{ margin: 0 }}>Cargando…</p> : null}
        {keys?.length === 0 ? <p style={{ margin: 0, color: 'var(--np-text-mute)' }}>Aún no tienes ninguna llave.</p> : null}
        {keys?.map((k) => (
          <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span>
              <strong style={{ fontWeight: 600 }}>{k.label}</strong>
              <span style={{ display: 'block', fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
                Dada de alta el {formatDateTime(k.createdAt)}
                {k.lastUsedAt ? ` · usada por última vez el ${formatDateTime(k.lastUsedAt)}` : ''}
              </span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => void remove(k.id)} disabled={busy}>
              Quitar
            </Button>
          </div>
        ))}
        {!supported ? <p style={{ margin: 0 }}>Este navegador no permite llaves de acceso: abre el panel en tu móvil para darla de alta.</p> : null}
        {supported && !adding ? (
          <Button variant="ghost" onClick={() => setAdding(true)}>
            Añadir una llave en este móvil
          </Button>
        ) : null}
        {supported && adding && !options ? (
          <form onSubmit={(e) => void begin(e)} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <Input label="Tu contraseña" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            {totpEnabled ? <OtpInput label="Código de tu app de verificación" value={code} onChange={setCode} required /> : null}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <Button type="submit" loading={busy}>
                Seguir
              </Button>
              <Button type="button" variant="ghost" onClick={reset}>
                Cancelar
              </Button>
            </div>
          </form>
        ) : null}
        {supported && options ? (
          <Button onClick={() => void create()} loading={busy}>
            Crear la llave con {unlock}
          </Button>
        ) : null}
        {error ? (
          <FormError>
            {error}
          </FormError>
        ) : null}
      </div>
    </SettingsCard>
  );
}
