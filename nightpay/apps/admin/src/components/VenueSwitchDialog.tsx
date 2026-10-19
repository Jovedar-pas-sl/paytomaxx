'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Modal } from '@nightpay/ui';
import { switchToVenue } from '@/lib/api';
import { totpLockedUntil } from '@/lib/api-errors';
import { OTP_LENGTH } from '@/lib/otp';
import { useLockActive } from '@/lib/use-lock';
import { ConfirmLine } from './ConfirmLine';
import { OtpInput } from './OtpInput';

interface Props {
  venueId: string;
  venueName: string;
  onClose: () => void;
}

/**
 * Super-admin: entrar en otro local (como su dueño) pide el código de la app
 * de verificación, igual que la consola. Se envía al poner la sexta cifra; si
 * va bien, se recarga el panel con el local nuevo (el API lo recuerda en la
 * sesión: no vuelve a pedirlo al refrescar).
 */
export function VenueSwitchDialog({ venueId, venueName, onClose }: Props) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 429 TOTP_LOCKED: hasta cuándo no se puede probar otro código. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (code.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');
    setError(null);
    setSubmitting(true);
    try {
      await switchToVenue(venueId, code);
      window.location.reload();
    } catch (err) {
      setLockedUntil(totpLockedUntil(err, Date.now()));
      setCode('');
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title="Entrar en otro local" width="28rem">
      <form onSubmit={(e) => void handleSubmit(e)} style={formStyle} noValidate>
        <ConfirmLine>{`Vas a entrar en ${venueName} como su dueño. Queda en el registro.`}</ConfirmLine>
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={code}
          onChange={setCode}
          autoSubmit
          autoFocus
          required
          lockedUntil={lockedUntil}
          disabled={submitting}
          hint="Al poner el sexto número se entra. Cada código vale una vez (cambia cada 30 s)."
        />
        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
        <div style={actionsStyle}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting} disabled={locked || code.length !== OTP_LENGTH}>
            Entrar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1rem' };

const errorStyle: CSSProperties = { color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' };

const actionsStyle: CSSProperties = { display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' };
