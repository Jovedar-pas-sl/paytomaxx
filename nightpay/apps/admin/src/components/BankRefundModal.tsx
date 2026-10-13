'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input, Modal } from '@nightpay/ui';
import { registerBankRefund, type PaymentRow } from '@/lib/api';

/**
 * Fase 1C — devolución hecha en el portal de BBVA. Redsys no devuelve por API
 * desde NightPay: el dueño devuelve en el banco y la apunta aquí, para que el
 * cobro, la parte de la chica y los informes cuadren.
 */
export function BankRefundModal({
  payment,
  onClose,
  onDone,
}: {
  payment: PaymentRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [refundedOn, setRefundedOn] = useState(today());
  const [bankReference, setBankReference] = useState('');
  const [reason, setReason] = useState('');
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (payment) {
      setAmount((payment.availableAmountCents / 100).toFixed(2));
      setRefundedOn(today());
      setBankReference('');
      setReason('');
      setNeedsConfirm(false);
      setConfirmed(false);
      setError(null);
    }
  }, [payment]);

  if (!payment) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!payment) return;
    setError(null);
    const cents = Math.round(parseFloat(amount.replace(',', '.')) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return setError('Pon el importe devuelto.');
    if (cents > payment.availableAmountCents) return setError('Es más de lo que queda por devolver en este cobro.');
    if (reason.trim().length < 3) return setError('Explica brevemente el motivo.');
    if (needsConfirm && !confirmed) return setError('Marca la casilla si es otra devolución distinta.');
    setSubmitting(true);
    try {
      await registerBankRefund(payment.id, {
        amountCents: cents,
        reason: reason.trim(),
        refundedOn,
        ...(bankReference.trim() ? { bankReference: bankReference.trim() } : {}),
        ...(confirmed ? { confirmDuplicate: true } : {}),
      });
      onDone();
    } catch (err) {
      const message = (err as Error).message;
      // Ya hay una devolución igual: se pide confirmar que es otra.
      if (message.includes('confírmalo')) setNeedsConfirm(true);
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Registrar devolución de BBVA">
      <ol style={stepsStyle}>
        <li>
          En el portal de BBVA, busca el pedido{' '}
          {payment.providerTxId ? <code style={codeStyle}>{payment.providerTxId}</code> : 'del cobro'} y haz la
          devolución.
        </li>
        <li>
          Apúntala aquí. NightPay ajusta el cobro y descuenta la parte de la chica, aunque ya se le haya pagado.
        </li>
      </ol>
      <p style={metaStyle}>
        Queda por devolver <span className="np-num">{(payment.availableAmountCents / 100).toFixed(2)} €</span>
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
        <Input
          label="Importe devuelto (€)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          size="lg"
          style={{ fontFamily: 'var(--np-font-mono)' }}
        />
        <Input
          label="Día de la devolución en el banco"
          type="date"
          value={refundedOn}
          max={today()}
          onChange={(e) => setRefundedOn(e.target.value)}
          required
        />
        <Input
          label="Referencia del banco (opcional)"
          value={bankReference}
          onChange={(e) => setBankReference(e.target.value)}
          maxLength={60}
          placeholder="la que da el portal de BBVA"
        />
        <Input
          label="Motivo"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder="ej: el cliente no reconoce el cargo"
          required
        />
        {needsConfirm ? (
          <label style={checkStyle}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Sí, es otra devolución distinta
          </label>
        ) : null}
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <Button variant="ghost" type="button" onClick={onClose} style={{ flex: 1 }}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting} style={{ flex: 1 }}>
            Registrar devolución
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Hoy en el navegador del dueño, como AAAA-MM-DD. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const stepsStyle: CSSProperties = {
  margin: 0,
  paddingLeft: '1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  color: 'var(--np-text-mute)',
  fontSize: '0.9375rem',
};
const metaStyle: CSSProperties = { margin: '0.75rem 0 0', fontSize: '0.9375rem' };
const codeStyle: CSSProperties = { fontFamily: 'var(--np-font-mono)', color: 'var(--np-text)' };
const checkStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 };
