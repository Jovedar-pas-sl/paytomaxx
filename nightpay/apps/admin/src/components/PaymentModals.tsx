'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input, Modal, Select } from '@nightpay/ui';
import {
  isApprovalRequested,
  parseEuroCents,
  PASSKEY_REQUIRED_CODE,
  stepUpActions,
  type ApprovalRequestedResponse,
  type StepUpProof,
} from '@nightpay/contracts';
import { refundPayment, resolveStuckPayment, type PaymentRow } from '@/lib/api';
import { ApiError, isRefundOutcomeUnknown, needsTotpCode, totpLockedUntil } from '@/lib/api-errors';
import { refundGoesToApproval, requestSummary } from '@/lib/approvals';
import { refundSummary } from '@/lib/confirm-summary';
import { formatDateTime } from '@/lib/dates';
import { useLockActive } from '@/lib/use-lock';
import { centsToInput, formatEur, formatMoney } from '@/lib/money';
import { proofFor, refundAutoSends, refundButtonText } from '@/lib/refund-confirm';
import { resolveProofFor, resolveProofValue } from '@/lib/resolve-stuck';
import { refundServiceFeeHint } from '@/lib/service-fee-text';
import { useStepUpMethod } from '@/lib/use-step-up-method';
import { useVenue, useVenueTimezone } from '@/lib/venue-context';
import { ConfirmLine } from './ConfirmLine';
import { KeyConfirm } from './KeyConfirm';
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
  const [totp, setTotp] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  useEffect(() => {
    if (payment) {
      setDecision('AUTHORIZED');
      setTotp('');
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
  // Con bitcoin no hay banco: la factura de BTCPay dice cuál se cobró.
  const proof = resolveProofFor(payment.provider);
  const bitcoin = proof.field === 'btcpayInvoiceRef';
  const tipsDiffer = new Set(chargeable.map((a) => a.tipCents ?? null)).size > 1;
  const needsOrder = decision === 'AUTHORIZED' && tipsDiffer && !bitcoin;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!payment) return;
    setError(null);
    const typed = resolveProofValue(proof, authCode);
    if (decision === 'AUTHORIZED' && !typed.ok) {
      setError(typed.error);
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
    if (decision === 'AUTHORIZED' && !/^\d{6}$/.test(totp)) {
      setError('Pon los 6 números de tu app de verificación.');
      return;
    }
    setSubmitting(true);
    try {
      await resolveStuckPayment(payment.id, {
        decision,
        reason: reason.trim(),
        ...(decision === 'AUTHORIZED' && typed.ok ? { [proof.field]: typed.value, totpCode: totp } : {}),
        ...(needsOrder ? { bankOrder } : {}),
      });
      onDone();
    } catch (err) {
      const until = totpLockedUntil(err, Date.now());
      if (until !== null) setLockedUntil(until);
      setTotp('');
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
        {payment.providerTxId && !bitcoin ? (
          <>
            {' '}
            · pedido <code style={codeStyle}>{payment.providerTxId}</code>
          </>
        ) : null}
        {bitcoin ? ' · pagado con bitcoin' : null}
      </p>
      {payment.attempts && payment.attempts.length > 0 && !bitcoin ? (
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
      <p style={{ ...metaStyle, marginTop: '0.5rem' }}>{proof.where}</p>
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
            label={proof.label}
            value={authCode}
            onChange={(e) => setAuthCode(e.target.value)}
            placeholder={proof.placeholder}
            maxLength={proof.maxLength}
            autoCapitalize={bitcoin ? 'off' : 'characters'}
            autoCorrect="off"
            spellCheck={false}
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
          placeholder={proof.reasonPlaceholder}
          maxLength={500}
          required
        />
        {decision === 'AUTHORIZED' ? (
          <OtpInput
            label="Código de tu app de verificación (2FA)"
            value={totp}
            onChange={setTotp}
            lockedUntil={lockedUntil}
            autoSubmit={false}
            required
            hint="Son los 6 números de tu app de verificación. Si aún no la tienes, actívala en Ajustes → Verificación en dos pasos."
          />
        ) : null}
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
  /** Sin 2FA y con llave: el API pidió confirmarla (PASSKEY_REQUIRED), o ya se sabía. */
  const [askedForKey, setAskedForKey] = useState(false);
  /** La confirmación con la llave para esta devolución (una vez, 2 minutos). */
  const [proof, setProof] = useState<StepUpProof | null>(null);
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
  const method = useStepUpMethod(open && Boolean(payment));

  useEffect(() => {
    if (payment) {
      setAmount(centsToInput(payment.availableAmountCents));
      setReason('');
      setTotp('');
      setAskedForCode(false);
      setAskedForKey(false);
      setProof(null);
      setError(null);
      setUnknownOutcome(null);
      setRequested(null);
    }
  }, [payment]);

  if (!payment) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  const cents = parseEuroCents(amount) ?? Number.NaN;
  // Desde el umbral del local, el encargado la pide al dueño (que la aprueba con su 2FA).
  const asking = refundGoesToApproval(requestFromCents, cents);
  const requires2FA = !asking && (askedForCode || askedForKey || (Number.isFinite(cents) && cents >= TWO_FA_THRESHOLD_CENTS));

  const validAmount = Number.isFinite(cents) && cents > 0 && cents <= payment.availableAmountCents;
  // Sin 2FA y con llave: se confirma con la llave antes del botón (no hay código que poner).
  const withKey = requires2FA && (method === 'passkey' || askedForKey);
  const action = validAmount ? stepUpActions.refund(payment.id, cents) : null;
  const keyProof = withKey ? proofFor(proof, action, Date.now()) : null;
  const buttonText = refundButtonText({ asking, cents, valid: validAmount }, formatEur);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void send(keyProof);
  }

  /** Por debajo de 100 €, confirmar con la llave la manda (como el sexto número); desde 100 €, el botón. */
  function onKeyProof(next: StepUpProof): void {
    setProof(next);
    if (refundAutoSends(cents)) void send(next);
  }

  async function send(withProof: StepUpProof | null): Promise<void> {
    // Un Intro a la vez que el código se envía solo no repite la devolución.
    if (!payment || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!Number.isFinite(cents) || cents <= 0) throw new Error('Importe inválido');
      if (cents > payment.availableAmountCents) throw new Error('Excede el importe disponible');
      if (withKey && !withProof) throw new Error('Confírmalo antes con tu llave de acceso.');
      if (requires2FA && !withKey && !/^\d{6}$/.test(totp)) throw new Error('Pon los 6 números de tu app de verificación.');
      const result = await refundPayment(
        payment.id,
        cents,
        reason || undefined,
        requires2FA && !withKey ? totp : undefined,
        withKey ? withProof?.token : undefined,
      );
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
      } else if (err instanceof ApiError && err.code === PASSKEY_REQUIRED_CODE) {
        // Sin 2FA y con llave (también por lo devuelto acumulado): se confirma con ella.
        setAskedForKey(true);
        setError(refundAutoSends(cents) ? 'Confírmalo con tu llave de acceso.' : `Confírmalo con tu llave de acceso y después pulsa «${buttonText}».`);
      } else if (needsTotpCode(err) && !requires2FA) {
        // Lo devuelto acumulado llega a 100 €: el API pide el código aunque este importe sea menor.
        setAskedForCode(true);
        setError(`${(err as Error).message} Pon el código y vuelve a confirmar.`);
      } else {
        setTotp('');
        setError((err as Error).message);
      }
    } finally {
      // La confirmación con la llave vale una vez: usada (bien o mal), otra para repetir.
      if (withProof) setProof(null);
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
    <Modal open={open} onClose={onClose} title="Devolver a la tarjeta">
      <p style={metaStyle}>
        ID <code style={codeStyle}>{payment.id.slice(0, 8)}…</code> · disponible{' '}
        <span className="np-num">{formatEur(payment.availableAmountCents)}</span>
      </p>
      {refundServiceFeeHint(payment) ? <p style={metaStyle}>{refundServiceFeeHint(payment)}</p> : null}
      <form onSubmit={handleSubmit} style={formStyle}>
        <Input
          label="Importe"
          suffix="€"
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
        {withKey ? (
          <KeyConfirm
            action={action}
            confirmed={Boolean(keyProof)}
            onProof={onKeyProof}
            reason={validAmount ? `Para devolver ${formatEur(cents)} a la tarjeta del cliente.` : 'Para devolver a la tarjeta del cliente.'}
            next={refundAutoSends(cents) ? 'Se está devolviendo.' : `Ahora pulsa «${buttonText}».`}
          />
        ) : requires2FA ? (
          <OtpInput
            label="Código de tu app de verificación (2FA)"
            value={totp}
            onChange={setTotp}
            autoSubmit={refundAutoSends(cents)}
            lockedUntil={lockedUntil}
            required
            hint={
              refundAutoSends(cents)
                ? 'Lo devuelto desde 100 € (de una vez o sumando) pide los 6 números de tu app de verificación; cada código vale una sola vez. Al poner el sexto número se confirma. Si aún no la tienes, actívala en Ajustes → Verificación en dos pasos.'
                : `Desde 100 € se piden los 6 números de tu app de verificación; cada código vale una sola vez. Después pulsa «${buttonText}»: no se manda sola. Si aún no la tienes, actívala (o da de alta tu llave de acceso) en Ajustes → Seguridad.`
            }
          />
        ) : null}
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
          {/* «Cancelar» es solo para un cobro sin pagar: aquí, «Dejarlo» (como al anular un cobro del saldo). */}
          <Button variant="ghost" type="button" onClick={onClose} style={{ flex: 1 }}>
            Dejarlo
          </Button>
          <Button
            type="submit"
            loading={submitting}
            disabled={(requires2FA && !withKey && locked) || (withKey && !keyProof)}
            style={{ flex: 1 }}
          >
            {buttonText}
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
  fontSize: '0.875rem',
};

const metaStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
};
