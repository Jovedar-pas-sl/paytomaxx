'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { passkeysSupported, type RequestOptionsJSON } from '@nightpay/api-client';
import { unlockName, type StepUpProof, type StepUpStatus } from '@nightpay/contracts';
import { Button, Modal } from '@nightpay/ui';
import { fetchStepUp, passkeyChallenge, passkeyConfirm, verifyStepUpWithCode } from '@/lib/api';
import { stepUpErrorText } from '@/lib/step-up';
import { OtpInput } from './OtpInput';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Verificado para ver lo delicado (5 minutos). */
  onVerified?: (status: StepUpStatus) => void;
  /**
   * Para repetir una acción sin 2FA (la del 403 PASSKEY_REQUIRED): la prueba
   * de un solo uso, que va en la cabecera X-Step-Up-Token al repetirla.
   */
  action?: string;
  onProof?: (proof: StepUpProof) => void;
  /** Qué se va a ver o hacer («Para ver el móvil y la IP del cliente»). */
  reason?: string;
}

/**
 * «Verificarte»: con el código de la 2FA si la tiene; si no, con su llave de
 * acceso (Face ID, huella o el PIN del móvil). Sin ninguna, le dice dónde
 * activarlas. El reto de la llave se pide al abrir: en el iPhone, Face ID
 * tiene que salir en el mismo toque.
 */
export function StepUpDialog({ open, onClose, onVerified, action, onProof, reason }: Props) {
  const unlock = unlockName(typeof navigator === 'undefined' ? null : navigator.userAgent);
  const [status, setStatus] = useState<StepUpStatus | null>(null);
  const [challenge, setChallenge] = useState<RequestOptionsJSON | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          const options = await passkeyChallenge(action);
          if (!cancelled) setChallenge(options);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(stepUpErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, action]);

  async function withCode(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      onVerified?.(await verifyStepUpWithCode(code));
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
      const out = await passkeyConfirm(challenge, action);
      if (out.proof) onProof?.(out.proof);
      else onVerified?.(out);
      onClose();
    } catch (err) {
      setError(stepUpErrorText(err));
      // Un reto se gasta con una firma buena o caduca: uno nuevo para el siguiente toque.
      passkeyChallenge(action).then(setChallenge, () => setChallenge(null));
    } finally {
      setBusy(false);
    }
  }

  const method = status?.method ?? null;
  return (
    <Modal open={open} onClose={onClose} title="Verificarte">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <p style={{ margin: 0, color: 'var(--np-text-mute)', fontSize: '1rem', lineHeight: 1.45 }}>
          {reason ?? 'Para ver lo delicado de un cobro.'} {action ? 'Vale para esto, una vez.' : 'Vale 5 minutos.'}
        </p>
        {status === null && !error ? <p style={{ margin: 0 }}>Un momento…</p> : null}
        {method === 'totp' && !action ? (
          <form onSubmit={(e) => void withCode(e)} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <OtpInput label="Código de tu app de verificación" value={code} onChange={setCode} autoFocus required disabled={busy} />
            <Button type="submit" loading={busy} disabled={code.length !== 6}>
              Verificar
            </Button>
          </form>
        ) : null}
        {method === 'totp' && action ? <p style={{ margin: 0 }}>Tienes la verificación en dos pasos: pon su código donde lo pide.</p> : null}
        {method === 'passkey' ? (
          passkeysSupported() ? (
            <Button onClick={() => void withPasskey()} loading={busy} disabled={!challenge}>
              Confirmar con {unlock}
            </Button>
          ) : (
            <p style={{ margin: 0 }}>Este navegador no permite llaves de acceso. Ábrelo en el móvil donde la diste de alta.</p>
          )
        ) : null}
        {status !== null && method === null ? (
          <p style={{ margin: 0 }}>
            Para esto hace falta la verificación en dos pasos o una llave de acceso en tu móvil. Las dos están en Ajustes → Seguridad.
          </p>
        ) : null}
        {error ? (
          <p role="alert" style={{ margin: 0, color: 'var(--np-danger)', fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
