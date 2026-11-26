'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input, Modal, Select } from '@nightpay/ui';
import {
  BITCOIN_CASH_REASONS,
  BITCOIN_CASH_REASON_LABELS,
  isApprovalRequested,
  parseEuroCents,
  type BitcoinCashConfig,
  type BitcoinCashReason,
} from '@nightpay/contracts';
import { refundPaymentInCash, returnInvoiceInCash } from '@/lib/api';
import { totpLockedUntil } from '@/lib/api-errors';
import { cashConfirmLine, cashGoesToOwner, cashMaxCents } from '@/lib/bitcoin-cash';
import { centsToInput, formatEur } from '@/lib/money';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';

/** Qué se devuelve: un cobro pagado con bitcoin o el bitcoin que llegó sin cobro (su factura). */
export type BitcoinCashTarget =
  | { kind: 'payment'; paymentId: string; leftCents: number; alreadyCents: number; label: string }
  | { kind: 'invoice'; invoiceId: string; leftCents: number; label: string };

interface Props {
  target: BitcoinCashTarget | null;
  config: BitcoinCashConfig | null;
  onClose: () => void;
  /** Hecho o pedido al dueño: la lista se vuelve a cargar. */
  onDone: () => void;
}

/**
 * «Devolver en efectivo» (encargado y dueño): importe (lo que queda; se puede
 * bajar, no subir), motivo, el código del recibo del cliente y la 2FA de quien
 * lo devuelve. Pasado el umbral del local, se pide al dueño: cuando lo apruebe,
 * en «Mis solicitudes» sale «Entregado». Siempre en euros; nunca bitcoin.
 */
export function BitcoinCashModal({ target, config, onClose, onDone }: Props) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<BitcoinCashReason>('WRONG_CHARGE');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState('');
  const [totp, setTotp] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [key, setKey] = useState('');

  useEffect(() => {
    if (!target) return;
    setAmount(centsToInput(cashMaxCents(config, target.leftCents)));
    setReason(target.kind === 'invoice' ? 'CHARGED_TWICE' : 'WRONG_CHARGE');
    setNote('');
    setReceipt('');
    setTotp('');
    setError(null);
    setResult(null);
    setKey(`btc-cash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  }, [target, config]);

  if (!target) return <Modal open={false} onClose={onClose}>{null}</Modal>;

  const max = cashMaxCents(config, target.leftCents);
  const cents = parseEuroCents(amount);
  const toOwner = cashGoesToOwner(config, target.kind === 'payment' ? target.alreadyCents : 0, cents ?? 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError(null);
    if (cents === null || cents <= 0) return setError('Escribe el importe.');
    if (cents > max) return setError(`Como mucho ${formatEur(max)}.`);
    if (reason === 'OTHER' && note.trim().length < 3) return setError('Con «Otro», escribe qué pasó.');
    if (receipt.trim().length < 3) return setError('Pon el código del recibo del cliente.');
    if (!toOwner && !/^\d{6}$/.test(totp)) return setError('Pon los 6 números de tu app de verificación.');
    const body = {
      amountCents: cents,
      reason,
      ...(reason === 'OTHER' ? { note: note.trim() } : {}),
      receiptCode: receipt.trim(),
      ...(toOwner ? {} : { totpCode: totp }),
      idempotencyKey: key,
    };
    setBusy(true);
    try {
      const out = target.kind === 'payment' ? await refundPaymentInCash(target.paymentId, body) : await returnInvoiceInCash(target.invoiceId, body);
      setResult(
        isApprovalRequested(out)
          ? `Pedido al dueño (${formatEur(out.amountCents)}). Cuando lo apruebe, en «Mis solicitudes» sale «Entregado»: púlsalo al darle el dinero.`
          : out.message,
      );
      onDone();
    } catch (err) {
      const until = totpLockedUntil(err, Date.now());
      if (until !== null) setLockedUntil(until);
      setTotp('');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Modal open onClose={onClose} title="Devolver en efectivo">
        <Notice tone="success">{result}</Notice>
        <div style={{ marginTop: '1rem' }}>
          <Button onClick={onClose}>Hecho</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Devolver en efectivo">
      <p style={metaStyle}>
        {target.label} · pagado con bitcoin. Se devuelve en euros, lo que pagó según la factura (sin ajuste por el cambio). Queda{' '}
        <span className="np-num">{formatEur(max)}</span>.
      </p>
      <form onSubmit={submit} style={formStyle}>
        <Input label="Importe" suffix="€" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
        <Select label="Motivo" value={reason} onChange={(e) => setReason(e.target.value as BitcoinCashReason)}>
          {BITCOIN_CASH_REASONS.map((r) => (
            <option key={r} value={r}>
              {BITCOIN_CASH_REASON_LABELS[r]}
            </option>
          ))}
        </Select>
        {reason === 'OTHER' ? <Input label="Qué pasó" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} required /> : null}
        <Input
          label="Código del recibo del cliente"
          value={receipt}
          onChange={(e) => setReceipt(e.target.value)}
          placeholder={target.kind === 'payment' ? 'ej: K7Q (el de su pantalla «Pagado»)' : 'el id de su recibo de BTCPay (vale un trozo)'}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={300}
          required
        />
        <p style={metaStyle}>
          {target.kind === 'payment'
            ? 'El cliente lo ve en su móvil: el código de la pantalla «Pagado» (3 letras) o el id de su recibo de BTCPay.'
            : 'El cliente lo ve en el recibo de BTCPay de su móvil: el id de la factura (vale un trozo de 6 letras o más).'}
        </p>
        <p style={{ ...metaStyle, color: 'var(--np-text)' }}>{cashConfirmLine(cents ? formatEur(cents) : '—')}</p>
        {toOwner ? (
          <Notice tone="info">Pasa del límite del local: se pide al dueño. Cuando lo apruebe, das el dinero y pulsas «Entregado».</Notice>
        ) : (
          <OtpInput
            label="Código de tu app de verificación (2FA)"
            value={totp}
            onChange={setTotp}
            lockedUntil={lockedUntil}
            autoSubmit={false}
            required
            hint="Son los 6 números de tu app de verificación."
          />
        )}
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={busy}>
          {toOwner ? 'Pedir al dueño' : 'Devolver en efectivo'}
        </Button>
      </form>
    </Modal>
  );
}

const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.25rem' };
const metaStyle: CSSProperties = { margin: 0, fontSize: '0.875rem', color: 'var(--np-text-mute)' };
