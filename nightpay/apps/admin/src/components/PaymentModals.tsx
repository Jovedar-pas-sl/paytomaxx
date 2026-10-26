'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input, Modal, Select } from '@nightpay/ui';
import { isApprovalRequested, parseEuroCents, type ApprovalRequestedResponse } from '@nightpay/contracts';
import { refundPayment, resolveStuckPayment, type PaymentRow } from '@/lib/api';
import { isRefundOutcomeUnknown, needsTotpCode, totpLockedUntil } from '@/lib/api-errors';
import { refundGoesToApproval, requestSummary } from '@/lib/approvals';
import { refundSummary } from '@/lib/confirm-summary';
import { formatDateTime } from '@/lib/dates';
import { useLockActive } from '@/lib/use-lock';
import { centsToInput, formatEur, formatMoney } from '@/lib/money';
import { refundServiceFeeHint } from '@/lib/service-fee-text';
import { useVenue, useVenueTimezone } from '@/lib/venue-context';
import { ConfirmLine } from './ConfirmLine';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';

/**
 * Desde este importe el código de la app de verificación se pide seguro. El
 * API nuevo lo pide también por lo devuelto acumulado (TOTP_REQUIRED): entonces
 * aparece el campo y se vuelve a confirmar.
 */
const TWO_FA_THRESHOLD_CENTS = 100_00;

export function ResolveModal({
  payment,
  onClose,
  onDone,
}: {
  payment: PaymentRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const tz = useVenueTimezone();
  const [decision, setDecision] = useState<'AUTHORIZED' | 'FAILED'>('AUTHORIZED');
  const [authCode, setAuthCode] = useState('');
  const [bankOrder, setBankOrder] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (payment) {
      setDecision('AUTHORIZED');
      setAuthCode('');
      setBankOrder('');
      setReason('');
      setError(null);
    }
  }, [payment]);

  if (!payment) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  // Fase 1B: si los intentos llevaban propinas distintas, hay que decir cuál
  // cobró el banco (la propina es de la chica). Los denegados no cuentan.
  const attempts = payment.attempts ?? [];
  const chargeable = attempts.filter((a) => a.status !== 'DENIED');
  const tipsDiffer = new Set(chargeable.map((a) => a.tipCents ?? null)).size > 1;
  const needsOrder = decision === 'AUTHORIZED' && tipsDiffer;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!payment) return;
    setError(null);
    const code = authCode.replace(/\s+/g, '').toUpperCase();
    if (decision === 'AUTHORIZED' && !/^[A-Z0-9]{6}$/.test(code)) {
      setError('Pon el código de autorización del banco: 6 letras o números.');
      return;
    }
    if (needsOrder && !bankOrder) {
      setError('Elige el pedido que aparece cobrado en el portal del banco.');
      return;
    }
    if (reason.trim().length < 3) {
      setError('Explica brevemente cómo lo has comprobado.');
      return;
    }
    setSubmitting(true);
    try {
      await resolveStuckPayment(payment.id, {
        decision,
        reason: reason.trim(),
        ...(decision === 'AUTHORIZED' ? { bankAuthCode: code } : {}),
        ...(needsOrder ? { bankOrder } : {}),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Resolver cobro">
      <p style={metaStyle}>
        <span className="np-num">{formatMoney(payment.amountCents, payment.currency)}</span>
        {' · '}
        {formatDateTime(payment.createdAt, tz, 'short')}
        {payment.providerTxId ? (
          <>
            {' '}
            · pedido <code style={codeStyle}>{payment.providerTxId}</code>
          </>
        ) : null}
      </p>
      {payment.attempts && payment.attempts.length > 0 ? (
        <ul style={{ ...metaStyle, margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
          {payment.attempts.map((a) => (
            <li key={a.providerTxId}>
              Pedido <code style={codeStyle}>{a.providerTxId}</code> · {formatDateTime(a.createdAt, tz, 'short')} ·{' '}
              {typeof a.amountCents === 'number' ? <span className="np-num">{formatEur(a.amountCents)} · </span> : null}
              {a.status === 'APPROVED' ? 'aprobado' : a.status === 'DENIED' ? 'denegado' : 'sin respuesta'}
            </li>
          ))}
        </ul>
      ) : null}
      <p style={{ ...metaStyle, marginTop: '0.5rem' }}>
        Búscalo en el portal del banco por importe, hora o número de pedido.
      </p>
      <form onSubmit={handleSubmit} style={formStyle}>
        <div
          role="radiogroup"
          aria-label="¿Se cobró?"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.5rem' }}
        >
          <Button
            type="button"
            variant={decision === 'AUTHORIZED' ? 'primary' : 'ghost'}
            aria-pressed={decision === 'AUTHORIZED'}
            onClick={() => setDecision('AUTHORIZED')}
          >
            Sí, se cobró
          </Button>
          <Button
            type="button"
            variant={decision === 'FAILED' ? 'primary' : 'ghost'}
            aria-pressed={decision === 'FAILED'}
            onClick={() => setDecision('FAILED')}
          >
            No se cobró
          </Button>
        </div>
        {decision === 'AUTHORIZED' ? (
          <Input
            label="Código de autorización del banco"
            value={authCode}
            onChange={(e) => setAuthCode(e.target.value)}
            placeholder="ej: 047215"
            maxLength={8}
            autoCapitalize="characters"
            required
          />
        ) : null}
        {needsOrder ? (
          <Select
            label="¿Qué pedido cobró el banco?"
            value={bankOrder}
            onChange={(e) => setBankOrder(e.target.value)}
            required
          >
            <option value="">Elige el pedido del portal del banco</option>
            {chargeable.map((a) => (
              <option key={a.providerTxId} value={a.providerTxId}>
                {a.providerTxId}
                {typeof a.amountCents === 'number' ? ` · ${formatEur(a.amountCents)}` : ''}
                {a.tipCents ? ` (propina ${formatEur(a.tipCents)})` : ''}
              </option>
            ))}
          </Select>
        ) : null}
        <Input
          label="Cómo lo has comprobado"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="ej: aparece en el portal BBVA a las 09:50"
          maxLength={500}
          required
        />
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={submitting}>
          {decision === 'AUTHORIZED' ? 'Marcar como cobrado' : 'Marcar como no cobrado'}
        </Button>
      </form>
    </Modal>
  );
}

export function RefundModal({
  open,
  payment,
  onClose,
  onDone,
  requestFromCents = null,
}: {
  open: boolean;
  payment: PaymentRow | null;
  onClose: () => void;
  onDone: () => void;
  /** «Por aprobar»: el encargado pide al dueño las devoluciones desde este importe (null = el dueño, nunca). */
  requestFromCents?: number | null;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [totp, setTotp] = useState('');
  const [askedForCode, setAskedForCode] = useState(false);
  /** 429 del API (demasiados códigos malos): hasta cuándo no se puede probar otro. Es de la cuenta, no del cobro. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** La pasarela no confirmó: la devolución queda pendiente (no repetirla). */
  const [unknownOutcome, setUnknownOutcome] = useState<string | null>(null);
  /** 202: no se devolvió, se pidió al dueño. */
  const [requested, setRequested] = useState<ApprovalRequestedResponse | null>(null);
  const venue = useVenue();

  useEffect(() => {
    if (payment) {
      setAmount(centsToInput(payment.availableAmountCents));
      setReason('');
      setTotp('');
      setAskedForCode(false);
      setError(null);
      setUnknownOutcome(null);
      setRequested(null);
    }
  }, [payment]);

  if (!payment) {
    return <Modal open={open} onClose={onClose}>{null}</Modal>;
  }

  const cents = parseEuroCents(amount) ?? Number.NaN;
  // Desde el umbral del local, el encargado la pide al dueño (que la aprueba con su 2FA).
  const asking = refundGoesToApproval(requestFromCents, cents);
  const requires2FA = !asking && (askedForCode || (Number.isFinite(cents) && cents >= TWO_FA_THRESHOLD_CENTS));

  const validAmount = Number.isFinite(cents) && cents > 0 && cents <= payment.availableAmountCents;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // El código se envía solo al completarlo: un Intro a la vez no repite la devolución.
    if (!payment || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!Number.isFinite(cents) || cents <= 0) throw new Error('Importe inválido');
      if (cents > payment.availableAmountCents) throw new Error('Excede el importe disponible');
      if (requires2FA && !/^\d{6}$/.test(totp)) throw new Error('Pon los 6 números de tu app de verificación.');
      const result = await refundPayment(payment.id, cents, reason || undefined, requires2FA ? totp : undefined);
      if (isApprovalRequested(result)) {
        setRequested(result);
        return;
      }
      onDone();
    } catch (err) {
      const lockEnds = totpLockedUntil(err, Date.now());
      if (isRefundOutcomeUnknown(err)) {
        setUnknownOutcome((err as Error).message);
      } else if (lockEnds !== null) {
        // 429 TOTP_LOCKED: el campo se bloquea hasta que el API deje probar otro.
        setLockedUntil(lockEnds);
        setAskedForCode(true);
        setTotp('');
        setError((err as Error).message);
      } else if (needsTotpCode(err) && !requires2FA) {
        // Lo devuelto acumulado llega a 100 €: el API pide el código aunque este importe sea menor.
        setAskedForCode(true);
        setError(`${(err as Error).message} Pon el código y vuelve a confirmar.`);
      } else {
        setTotp('');
        setError((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (requested) {
    return (
      <Modal open={open} onClose={onDone} title="Pedido al dueño">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Notice tone="info">{requested.message}</Notice>
          <p style={metaStyle}>
            Devolución de <span className="np-num">{formatEur(requested.amountCents)}</span>: no se hace hasta que el
            dueño la apruebe. Mientras, ese importe queda reservado. La verás en «Mis solicitudes».
          </p>
          <Button onClick={onDone}>Entendido</Button>
        </div>
      </Modal>
    );
  }

  if (unknownOutcome) {
    return (
      <Modal open={open} onClose={onDone} title="Devolución sin confirmar">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Notice tone="warning">
            El banco no ha confirmado la devolución; queda pendiente. Revísala en el portal de la pasarela y, pasados
            2 minutos, márcala como hecha o no hecha en «Devoluciones» de este cobro. No la repitas.
          </Notice>
          <p style={metaStyle}>{unknownOutcome}</p>
          <Button onClick={onDone}>Entendido</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Reembolsar pago">
      <p style={metaStyle}>
        ID <code style={codeStyle}>{payment.id.slice(0, 8)}…</code> · disponible{' '}
        <span className="np-num">{formatEur(payment.availableAmountCents)}</span>
      </p>
      {refundServiceFeeHint(payment) ? <p style={metaStyle}>{refundServiceFeeHint(payment)}</p> : null}
      <form onSubmit={handleSubmit} style={formStyle}>
        <Input
          label="Importe (€)"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          size="lg"
          style={{ fontFamily: 'var(--np-font-mono)' }}
        />
        <Input
          label="Razón (opcional)"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
        {validAmount && asking ? (
          <ConfirmLine>
            {requestSummary({
              kind: 'REFUND',
              amountCents: cents,
              to: payment.cardLast4 ? `a la tarjeta ••${payment.cardLast4}` : 'al cliente de este cobro',
              venueName: venue.name ?? venue.slug,
            })}
          </ConfirmLine>
        ) : validAmount ? (
          <ConfirmLine>
            {refundSummary({
              amountCents: cents,
              cardLast4: payment.cardLast4 ?? null,
              venueName: venue.name ?? venue.slug,
            })}
          </ConfirmLine>
        ) : null}
        {requires2FA ? (
          <OtpInput
            label="Código de tu app de verificación (2FA)"
            value={totp}
            onChange={setTotp}
            autoSubmit
            lockedUntil={lockedUntil}
            required
            hint="Lo devuelto desde 100 € (de una vez o sumando) pide los 6 números de tu app de verificación; cada código vale una sola vez. Al poner el sexto número se confirma. Si aún no la tienes, actívala en Ajustes → Verificación en dos pasos."
          />
        ) : null}
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
          <Button variant="ghost" type="button" onClick={onClose} style={{ flex: 1 }}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting} disabled={requires2FA && locked} style={{ flex: 1 }}>
            {asking ? 'Pedir al dueño' : 'Confirmar reembolso'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.25rem' };

const codeStyle: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  background: 'var(--np-surface-2)',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  fontSize: '0.75rem',
};

const metaStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  color: 'var(--np-text-mute)',
};
