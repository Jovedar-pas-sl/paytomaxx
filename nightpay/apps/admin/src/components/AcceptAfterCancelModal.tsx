'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Input, Modal } from '@nightpay/ui';
import { acceptAfterCancel, type Incident } from '@/lib/api';
import { totpLockedUntil } from '@/lib/api-errors';
import { OtpInput } from './OtpInput';

/**
 * «Dar por bueno» (encargado o dueño, con su 2FA): el banco cobró un cobro que
 * el personal ya había cancelado y el local se lo queda. Pasa a pagado con su
 * nota (queda en el aviso cerrado y en el registro). Si no, se devuelve en el
 * banco y se cierra el aviso con una nota.
 */
export function AcceptAfterCancelModal({ incident, onClose, onDone }: { incident: Incident | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  useEffect(() => {
    setNote('');
    setTotp('');
    setError(null);
    setLockedUntil(null);
  }, [incident]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!incident?.paymentId || busy) return;
    if (note.trim().length < 3) return setError('Escribe por qué lo das por bueno.');
    if (!/^\d{6}$/.test(totp)) return setError('Pon los 6 números de tu app de verificación.');
    setBusy(true);
    setError(null);
    try {
      await acceptAfterCancel(incident.paymentId, { eventId: incident.refId, note: note.trim(), totpCode: totp });
      onDone();
      onClose();
    } catch (err) {
      const until = totpLockedUntil(err, Date.now());
      if (until) setLockedUntil(until);
      setTotp('');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={incident !== null} onClose={onClose} title="Dar por bueno">
      <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: '0.75rem' }}>
        <p style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>{incident?.title}</p>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
          El cobro pasa a pagado con lo que cobró el banco (su propina y la comisión de la compañera, como un pago normal). Si prefieres
          devolverlo, hazlo en el banco y cierra el aviso con una nota.
        </p>
        <Input
          label="Por qué lo das por bueno"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          placeholder="ej: se queda, era su segunda copa"
          required
          autoFocus
        />
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={totp}
          onChange={setTotp}
          lockedUntil={lockedUntil}
          autoSubmit={false}
          required
          hint="Son los 6 números de tu app de verificación."
        />
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        <div className="np-pregunta-pie">
          <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={busy}>
            Volver
          </Button>
          <Button type="submit" size="lg" loading={busy} disabled={busy}>
            Dar por bueno
          </Button>
        </div>
      </form>
    </Modal>
  );
}
