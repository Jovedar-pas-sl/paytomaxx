'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input, Modal } from '@nightpay/ui';
import type { CobroRow } from '@nightpay/contracts';
import { reverseWalletCharge } from '@/lib/api';
import { totpRetryState } from '@/lib/api-errors';
import { formatEur } from '@/lib/money';
import { reverseChargeText } from '@/lib/money-map';
import { OTP_LENGTH } from '@/lib/otp';
import { OtpInput } from './OtpInput';

/**
 * Anular un cobro pagado con saldo: el dinero vuelve al saldo del cliente. Con
 * motivo y código 2FA siempre, porque ese saldo se puede pedir en efectivo.
 */
export function ReverseChargeModal({
  row,
  target,
  onClose,
  onDone,
}: {
  row: CobroRow;
  target: { walletId: string; consumptionId: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const ready = reason.trim().length > 0 && totp.length === OTP_LENGTH;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await reverseWalletCharge(target, { reason: reason.trim(), totpCode: totp });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setLockedUntil(totpRetryState(err, Date.now()).lockedUntil);
      setTotp('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`¿Anular el cobro ${row.ref ?? ''} de ${formatEur(row.amountCents + row.tipCents)}?`}>
      <form onSubmit={(e) => void submit(e)} style={formStyle}>
        <p style={textStyle}>{reverseChargeText(row, formatEur)}</p>
        <Input label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required autoFocus />
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={totp}
          onChange={setTotp}
          autoSubmit={false}
          lockedUntil={lockedUntil}
          required
          hint="Si aún no la tienes, actívala en Ajustes → Seguridad."
        />
        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
        <div style={actionsStyle}>
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy} style={{ flex: 1 }}>
            Dejarlo
          </Button>
          <Button type="submit" loading={busy} disabled={!ready} style={{ flex: 1 }}>
            Anular cobro
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.25rem' };
const textStyle: CSSProperties = { margin: 0, color: 'var(--np-text-mute)' };
const errorStyle: CSSProperties = { color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' };
const actionsStyle: CSSProperties = { display: 'flex', gap: '0.75rem', marginTop: '0.5rem' };
