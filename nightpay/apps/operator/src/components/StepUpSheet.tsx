'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { passkeysSupported, type RequestOptionsJSON } from '@nightpay/api-client';
import { unlockName, type StepUpStatus } from '@nightpay/contracts';
import { Button, FormError, Input, Sheet } from '@nightpay/ui';
import { fetchStepUp, passkeyChallenge, passkeyConfirm, stepUpErrorText, verifyStepUpWithCode } from '@/lib/api-step-up';

/**
 * «Verificarte» en la app del personal: para ver lo delicado de un cobro suyo
 * (5 minutos). Con el código de la 2FA si la tiene; si no, con su llave de
 * acceso (el reto se pide al abrir: en el iPhone, Face ID sale en el mismo
 * toque). Sin ninguna, le dice dónde darla de alta.
 */
export function StepUpSheet({ open, onClose, onVerified }: { open: boolean; onClose: () => void; onVerified: (s: StepUpStatus) => void }) {
  const unlock = unlockName(typeof navigator === 'undefined' ? null : navigator.userAgent);
  const [status, setStatus] = useState<StepUpStatus | null>(null);
  const [challenge, setChallenge] = useState<RequestOptionsJSON | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setCode('');
    setChallenge(null);
    fetchStepUp()
      .then(async (s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.method === 'passkey' && passkeysSupported()) {
          const options = await passkeyChallenge();
          if (!cancelled) setChallenge(options);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(stepUpErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function withCode(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !/^\d{6}$/.test(code)) return;
    setBusy(true);
    setError(null);
    try {
      onVerified(await verifyStepUpWithCode(code));
      onClose();
    } catch (err) {
      setError(stepUpErrorText(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function withPasskey(): Promise<void> {
    if (busy || !challenge) return;
    setBusy(true);
    setError(null);
    try {
      onVerified(await passkeyConfirm(challenge));
      onClose();
    } catch (err) {
      setError(stepUpErrorText(err));
      passkeyChallenge().then(setChallenge, () => setChallenge(null));
    } finally {
      setBusy(false);
    }
  }

  const method = status?.method ?? null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Verificarte"
      footer={
        method === 'totp' ? (
          <Button type="submit" form={formId} loading={busy} disabled={code.length !== 6}>
            Verificar
          </Button>
        ) : method === 'passkey' ? (
          <Button onClick={() => void withPasskey()} loading={busy} disabled={!challenge}>
            Confirmar con {unlock}
          </Button>
        ) : undefined
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <p style={{ margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' }}>Para ver más de este cobro. Vale 5 minutos.</p>
        {method === 'totp' ? (
          <form id={formId} onSubmit={(e) => void withCode(e)} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <Input
              label="Código de tu app de verificación"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </form>
        ) : null}
        {status !== null && method === null ? (
          <p style={{ margin: 0 }}>Para ver más, da de alta tu llave de acceso: en el menú, «Llave de acceso».</p>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}
      </div>
    </Sheet>
  );
}
