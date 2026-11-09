'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input, Modal, Select } from '@nightpay/ui';
import { isApprovalRequested, type ApprovalRequestedResponse } from '@nightpay/contracts';
import {
  confirmPayoutManual,
  createOperatorPayout,
  fetchExchangeRate,
  verifyPayout,
  type PayoutMethod,
} from '@/lib/api';
import { ApiError, needsTotpCode, totpLockedUntil } from '@/lib/api-errors';
import { requestSummary } from '@/lib/approvals';
import { payoutHoldNote } from '@/lib/bank-holds';
import { payoutSummary } from '@/lib/confirm-summary';
import { payoutAttempt, payoutFailure, payoutWhat, type PayoutAttempt } from '@/lib/payout-attempt';
import { formatDecimal, formatEur } from '@/lib/money';
import { isAutoVerifiable, payoutAddressError } from '@/lib/payout-address';
import { describeVerifyResult, payoutReferenceError, type VerifyOutcome } from '@/lib/payout-verify';
import { useLockActive } from '@/lib/use-lock';
import { useVenue } from '@/lib/venue-context';
import { ConfirmLine } from './ConfirmLine';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';
import { PAYOUT_METHOD_LABELS, PAYOUT_METHOD_SHORT, PayoutMethodOptions } from './PayoutMethodForm';

interface Props {
  operatorId: string;
  /** Para la frase de confirmación ("… a Ana"). */
  operatorName: string;
  balanceCents: number;
  /** Lo retenido por ventas por datáfono sin cuadrar con el banco: no entra en este pago (se dice). */
  bankHeld?: { bankHeldCents?: number; bankHeldCount?: number };
  payoutMethod: PayoutMethod | null;
  payoutAddress: string | null;
  payoutLabel: string | null;
  onClose: () => void;
  /** El pago quedó apuntado (haya ido bien o no la verificación) o pedido: refrescar. */
  onDone: () => void;
  /**
   * «Por aprobar»: 'pay' el dueño (2FA si la tiene); 'pay_2fa' el encargado
   * que paga directo (2FA siempre); 'request' el encargado que lo pide al dueño.
   */
  mode?: 'pay' | 'pay_2fa' | 'request';
}

type Rate = { rate: number; degraded: boolean } | 'loading' | 'unavailable' | null;

interface Created {
  totalCents: number;
  earningCount: number;
  outcome: VerifyOutcome;
}

/**
 * "Marcar pagado": apunta la liquidación y, si hay referencia, la verifica
 * (cripto, contra la red) o la confirma a mano. El resultado se enseña antes
 * de cerrar: antes un fallo de verificación iba a la consola y el modal se
 * cerraba como si todo hubiera ido bien.
 */
export function PayoutConfirmModal({
  operatorId,
  operatorName,
  balanceCents,
  bankHeld,
  payoutMethod,
  payoutAddress,
  payoutLabel,
  onClose,
  onDone,
  mode = 'pay',
}: Props) {
  const holdNote = bankHeld ? payoutHoldNote(bankHeld) : null;
  const asking = mode === 'request';
  // Sin método guardado no se supone efectivo: hay que elegir cómo se pagó.
  const [rail, setRail] = useState<PayoutMethod | ''>(payoutMethod ?? '');
  const [notes, setNotes] = useState('');
  const [externalTxId, setExternalTxId] = useState('');
  const [receiptUrl, setReceiptUrl] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState<Rate>(null);
  const [created, setCreated] = useState<Created | null>(null);
  /** 202: el local pide la aprobación del dueño; no se pagó, se pidió. */
  /** El API pidió el código (403 TOTP_REQUIRED): la cuenta tiene la 2FA activada. */
  const [askedForCode, setAskedForCode] = useState(mode === 'pay_2fa');
  /** 202: el API no pagó, lo pidió al dueño. */
  const [requested, setRequested] = useState<ApprovalRequestedResponse | null>(null);
  /** 429 TOTP_LOCKED: hasta cuándo no se puede probar otro código. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  /** 409 PAYOUT_CHANGED: la cifra de aquí ya no vale; se cierra para ver la nueva. */
  const [stale, setStale] = useState(false);
  // Idempotency-Key del intento, atada a la cifra, el método y la referencia.
  const attempt = useRef<PayoutAttempt | null>(null);
  const locked = useLockActive(lockedUntil);
  const venue = useVenue();
  const confirmId = useId();
  const railId = useId();

  const chosenRail = rail === '' ? null : rail;
  const autoVerifiable = isAutoVerifiable(chosenRail);
  // La dirección guardada es la del método guardado; pagando por otra vía no aplica.
  const address = chosenRail === payoutMethod ? payoutAddress : null;
  const savedAddressProblem = address && chosenRail ? payoutAddressError(chosenRail, address) : null;

  useEffect(() => {
    if (!autoVerifiable) {
      setRate(null);
      return undefined;
    }
    let cancelled = false;
    setRate('loading');
    fetchExchangeRate()
      .then((r) => {
        if (!cancelled) setRate({ rate: r.rate, degraded: r.degraded });
      })
      .catch(() => {
        // Sin tasa no se inventa una: se dice que no está.
        if (!cancelled) setRate('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [autoVerifiable]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // El código se envía solo al completarlo: un Intro a la vez no apunta el pago dos veces.
    if (submitting || stale) return;
    setError(null);
    if (!chosenRail) return setError('Elige cómo le has pagado.');
    const referenceProblem = payoutReferenceError({ externalTxId, receiptUrl });
    if (referenceProblem) return setError(referenceProblem);
    if (!asking && askedForCode && !totpCode) return setError('Pon los 6 números de tu app de verificación.');
    if (!asking && totpCode && !/^\d{6}$/.test(totpCode)) return setError('El código 2FA son 6 números.');
    if (!confirmed) return setError(asking ? 'Marca la casilla para pedirlo.' : 'Marca la casilla para confirmar el pago.');

    setSubmitting(true);
    const txId = externalTxId.trim();
    const receipt = receiptUrl.trim();
    attempt.current = payoutAttempt(
      attempt.current,
      payoutWhat({ operatorId, totalCents: balanceCents, rail: chosenRail, txId, receipt }),
    );
    try {
      const payout = await createOperatorPayout(operatorId, {
        notes: notes.trim() || undefined,
        externalTxId: txId || undefined,
        externalRail: chosenRail,
        receiptUrl: receipt || undefined,
        totpCode: asking ? undefined : totpCode || undefined,
        // Lo que ve el dueño: si lo pagable cambió entre medias, el API no apunta otra cifra.
        expectedTotalCents: balanceCents,
        idempotencyKey: attempt.current.key,
      });
      // El encargado (o un local que cambió de regla): pedido al dueño, no pagado.
      if (isApprovalRequested(payout)) {
        setRequested(payout);
        return;
      }
      const outcome = await settle(payout.id, chosenRail, txId, receipt);
      setCreated({ totalCents: payout.totalCents, earningCount: payout.earningCount, outcome });
    } catch (err) {
      const lockEnds = totpLockedUntil(err, Date.now());
      if (lockEnds !== null) {
        setLockedUntil(lockEnds);
        setTotpCode('');
      } else if (needsTotpCode(err)) {
        setAskedForCode(true);
      } else if (err instanceof ApiError && err.code === 'TOTP_INVALID') {
        setTotpCode('');
      }
      // Cifra cambiada: cerrar y ver la nueva. Sin respuesta: puede que se
      // apuntara (repetir lleva la misma clave). Si no, se corrige y se repite.
      const failure = payoutFailure(err);
      if (failure.kind === 'changed') setStale(true);
      setError(failure.text);
    } finally {
      setSubmitting(false);
    }
  }

  const closeGuarded = submitting ? () => undefined : created || requested ? onDone : onClose;
  const currency = chosenRail?.startsWith('USDC') ? 'USDC' : 'USDT';

  if (requested) {
    return (
      <Modal open onClose={closeGuarded} title="Pedido al dueño" width="32rem">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Notice tone="info">{requested.message}</Notice>
          <p style={{ margin: 0, fontSize: '0.9375rem' }}>
            Pago de <strong className="np-num">{formatEur(requested.amountCents)}</strong> a {operatorName}. No se apunta
            hasta que el dueño lo apruebe; lo verás en «Mis solicitudes» (y, si lo rechaza, el motivo).
          </p>
          <Button onClick={onDone}>Cerrar</Button>
        </div>
      </Modal>
    );
  }

  if (created) {
    return (
      <Modal open onClose={closeGuarded} title="Pago apuntado" width="32rem">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <p style={{ margin: 0 }}>
            Liquidación de <strong className="np-num">{formatEur(created.totalCents)}</strong> (
            {created.earningCount === 1 ? '1 comisión' : `${created.earningCount} comisiones`}).
          </p>
          <Notice tone={created.outcome.tone}>{created.outcome.message}</Notice>
          <Button onClick={onDone}>Cerrar</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={closeGuarded} title={asking ? 'Pedir pago al dueño' : 'Marcar pagado'} width="32rem">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <p style={{ margin: 0, fontSize: '0.9375rem' }}>
          Saldo pendiente a liquidar: <strong className="np-num">{formatEur(balanceCents)}</strong>
          {autoVerifiable ? <RateNote rate={rate} balanceCents={balanceCents} currency={currency} /> : null}
        </p>
        {holdNote ? <Notice tone="warning">{holdNote}</Notice> : null}

        {payoutMethod ? (
          <div style={methodBox}>
            <p style={methodKicker}>Método de la chica</p>
            <p style={{ margin: '0.25rem 0 0' }}>
              <strong>{PAYOUT_METHOD_LABELS[payoutMethod]}</strong>
            </p>
            {payoutAddress ? (
              <p style={addressStyle}>
                {payoutAddress}
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(payoutAddress)}
                  style={copyBtn}
                >
                  Copiar
                </button>
              </p>
            ) : null}
            {payoutLabel ? (
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--np-text-dim)' }}>
                Alias: {payoutLabel}
              </p>
            ) : null}
            {savedAddressProblem ? (
              <Notice tone="warning" style={{ marginTop: '0.5rem' }}>
                La dirección guardada no parece válida para este método ({savedAddressProblem}) Revísala en Editar
                antes de pagar.
              </Notice>
            ) : null}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <Notice tone="warning">
              Esta chica no tiene método de cobro guardado. Elige cómo le has pagado. Para verificar pagos cripto
              solos, guarda antes su dirección en Editar.
            </Notice>
            <label htmlFor={railId} style={fieldLabel}>
              ¿Cómo le has pagado?
            </label>
            <Select id={railId} value={rail} onChange={(e) => setRail(e.target.value as PayoutMethod | '')} required>
              <option value="">— Elige el método —</option>
              {/* Sin dirección guardada no hay verificación on-chain posible. */}
              <PayoutMethodOptions include={(m) => !isAutoVerifiable(m)} />
            </Select>
          </div>
        )}

        <Input
          label={autoVerifiable ? 'Hash de la transacción on-chain' : 'Referencia externa (receipt ID, SEPA ref, etc.)'}
          value={externalTxId}
          onChange={(e) => setExternalTxId(e.target.value)}
          placeholder={autoVerifiable ? '0x... o TxId Tron' : 'Receipt ID, número SEPA, etc.'}
          hint={
            autoVerifiable
              ? 'Se verificará contra la red al apuntarlo.'
              : 'Opcional. Si la pones, el pago queda confirmado a mano.'
          }
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          label="Receipt URL (opcional, screenshot)"
          value={receiptUrl}
          onChange={(e) => setReceiptUrl(e.target.value)}
          placeholder="https://..."
          inputMode="url"
          maxLength={500}
        />
        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder='"Pagado vía Binance", "Wire SEPA enviado", etc.'
          maxLength={500}
        />
        <label htmlFor={confirmId} style={confirmStyle}>
          <input
            id={confirmId}
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            style={{ marginTop: '0.2rem' }}
          />
          <span>
            {asking ? 'Pido al dueño que apruebe pagar' : 'Confirmo que he pagado'}{' '}
            <strong className="np-num">{formatEur(balanceCents)}</strong>
            {chosenRail ? <> por {PAYOUT_METHOD_LABELS[chosenRail]}</> : null}
            {address ? (
              <>
                {' '}
                a <code style={inlineCode}>{address}</code>
              </>
            ) : null}
            .
          </span>
        </label>

        {chosenRail && balanceCents > 0 && asking ? (
          <ConfirmLine>
            {requestSummary({
              kind: 'PAYOUT',
              amountCents: balanceCents,
              to: operatorName,
              venueName: venue.name ?? venue.slug,
            })}
          </ConfirmLine>
        ) : chosenRail && balanceCents > 0 ? (
          <ConfirmLine>
            {payoutSummary({
              amountCents: balanceCents,
              operatorName,
              methodLabel: PAYOUT_METHOD_SHORT[chosenRail],
              target: address,
              venueName: venue.name ?? venue.slug,
            })}
          </ConfirmLine>
        ) : null}

        {asking ? null : (
        <OtpInput
          label={askedForCode ? 'Código de tu app de verificación (2FA)' : 'Código 2FA (si tienes la app activada)'}
          value={totpCode}
          onChange={setTotpCode}
          autoSubmit={confirmed && Boolean(chosenRail)}
          lockedUntil={lockedUntil}
          required={askedForCode}
          hint={
            confirmed
              ? 'Al poner el sexto número se confirma la liquidación. Cada código vale una sola vez.'
              : 'Marca antes la casilla; luego, al poner el sexto número, se confirma.'
          }
        />
        )}

        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        {stale ? (
          <Button type="button" onClick={onDone}>
            Cerrar y ver la cifra nueva
          </Button>
        ) : (
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <Button variant="ghost" type="button" onClick={onClose} disabled={submitting} style={{ flex: 1 }}>
              Cancelar
            </Button>
            <Button
              type="submit"
              loading={submitting}
              disabled={!confirmed || !chosenRail || (!asking && askedForCode && locked)}
              style={{ flex: 1 }}
            >
              {asking ? 'Pedir al dueño' : 'Confirmar liquidación'}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}

/**
 * Tras apuntar la liquidación: verificar (cripto) o confirmar a mano (con
 * referencia). Un fallo aquí no deshace el pago: se cuenta qué pasó. También
 * al aprobar un pago pedido por el encargado con su referencia («Por aprobar»).
 */
export async function settle(payoutId: string, rail: PayoutMethod, txId: string, receipt: string): Promise<VerifyOutcome> {
  if (!txId) {
    return {
      tone: 'info',
      message: 'Sin referencia queda «sin verificar». Puedes añadirla luego en Liquidaciones → Verificar.',
    };
  }
  try {
    if (isAutoVerifiable(rail)) {
      const result = await verifyPayout(payoutId, {
        externalTxId: txId,
        externalRail: rail,
        receiptUrl: receipt || undefined,
      });
      return describeVerifyResult(result);
    }
    await confirmPayoutManual(payoutId, { externalTxId: txId, ...(receipt ? { receiptUrl: receipt } : {}) });
    return { tone: 'success', message: 'Referencia apuntada y pago confirmado a mano.' };
  } catch (err) {
    // Ese hash ya justifica otro pago: no es un fallo pasajero, hay que poner el bueno.
    const txUsed = err instanceof ApiError && err.code === 'PAYOUT_TX_ALREADY_USED';
    return {
      tone: txUsed ? 'danger' : 'warning',
      message: `El pago quedó apuntado, pero no se pudo ${isAutoVerifiable(rail) ? 'verificar' : 'confirmar'}: ${
        (err as Error).message
      } ${txUsed ? 'Pon el hash correcto' : 'Puedes reintentarlo'} en Liquidaciones → Verificar.`,
    };
  }
}

function RateNote({ rate, balanceCents, currency }: { rate: Rate; balanceCents: number; currency: string }) {
  if (rate === null || rate === 'loading') return null;
  if (rate === 'unavailable') {
    return <span style={rateStyle}>· tasa no disponible</span>;
  }
  return (
    <span style={rateStyle}>
      ≈ {formatDecimal((balanceCents / 100) * rate.rate, 2)} {currency}
      {rate.degraded ? ' (tasa aproximada: Binance no responde)' : ''}
    </span>
  );
}

const rateStyle: CSSProperties = { color: 'var(--np-text-mute)', fontSize: '0.875rem', marginLeft: '0.5rem' };

const methodBox: CSSProperties = {
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  padding: '0.75rem 1rem',
  fontSize: '0.875rem',
};

const methodKicker: CSSProperties = {
  margin: 0,
  color: 'var(--np-text-mute)',
  fontSize: '0.75rem',
  fontWeight: 500,
};

const addressStyle: CSSProperties = {
  margin: '0.25rem 0 0',
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.8125rem',
  color: 'var(--np-text-mute)',
  wordBreak: 'break-all',
};

const copyBtn: CSSProperties = {
  marginLeft: '0.5rem',
  background: 'none',
  border: '1px solid var(--np-border)',
  color: 'var(--np-text-mute)',
  fontSize: '0.75rem',
  padding: '0.15rem 0.5rem',
  borderRadius: '4px',
  cursor: 'pointer',
};

const fieldLabel: CSSProperties = {
  fontSize: '0.8125rem',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
};

const confirmStyle: CSSProperties = {
  display: 'flex',
  gap: '0.6rem',
  alignItems: 'flex-start',
  fontSize: '0.875rem',
  padding: '0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  cursor: 'pointer',
};

const inlineCode: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.8125rem',
  wordBreak: 'break-all',
};
