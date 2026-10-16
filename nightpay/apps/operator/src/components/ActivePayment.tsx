'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Button,
  Card,
  QrCountdown,
  StatusPill,
  effectiveStatus,
  isPreCobro,
  outcomeKindOf,
  qrDeadline,
  useNow,
  useWakeLock,
  type OutcomeAction,
  type OutcomeKind,
  type PaymentStatus,
} from '@nightpay/ui';
import { cancelPayment, type CreatedPayment } from '@/lib/api';
import { useHealthReport } from '@/lib/connection-health';
import { formatEur, formatEurAmount } from '@/lib/money';
import { useOpenCharge } from '@/lib/open-charges';
import { advanceStatus, isFinalStatus } from '@/lib/payment-status';
import { NewWalletCard } from './NewWalletCard';
import { StaffOutcome } from './StaffOutcome';
import { usePaymentLive } from './use-payment-live';

interface Props {
  payment: CreatedPayment;
  /** Cobro con datáfono: el QR es para el camarero, no para el cliente. */
  isPos: boolean;
  /** El servicio de la carta que se cobra (null: importe tecleado). */
  label: string | null;
  /** Se ha pagado: refrescar el saldo. */
  onPaid: () => void;
  /** Volver al formulario (tras pagado, cancelado o caducado). */
  onClose: () => void;
  /** «Otro QR · mismo importe»: otro cobro igual, sin teclear nada (rechazado o caducado). */
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: string | null;
}

/**
 * El cobro recién creado: su QR con la cuenta atrás, su estado en tiempo real
 * (con sondeo de respaldo) y, al terminar, el resultado a pantalla completa.
 * Sigue vivo aunque la chica cambie de pestaña; mientras está abierto, la
 * pantalla no se apaga.
 */
export function ActivePayment({ payment, isPos, label, onPaid, onClose, onRetry, retrying = false, retryError = null }: Props) {
  const [status, setStatus] = useState<PaymentStatus>(payment.status as PaymentStatus);
  // Fase 1B — propina que eligió el cliente en su página de pago.
  const [tipCents, setTipCents] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [paidSeen, setPaidSeen] = useState(false);
  // Recarga de saldo pagada: tras el «PAGADO», su código y su PIN.
  const [outcomeDismissed, setOutcomeDismissed] = useState(false);
  // El plazo cuenta desde que llegó la respuesta, con la duración que dio el servidor.
  const [receivedAt] = useState(() => Date.now());
  const deadline = useMemo(
    () => qrDeadline(payment.qrExpiresAt, receivedAt, payment.createdAt),
    [payment.qrExpiresAt, payment.createdAt, receivedAt],
  );
  const [authorizingSince, setAuthorizingSince] = useState<number | null>(null);

  const { reachable } = usePaymentLive(payment, (update) => {
    setStatus((current) => advanceStatus(current, update.status));
    if (update.tipCents !== undefined) setTipCents(update.tipCents);
    if (update.status === 'AUTHORIZED') setPaidSeen(true);
  });

  // Pagado (por el socket o por el sondeo, lo que llegue antes): una vez.
  useEffect(() => {
    if (paidSeen) onPaid();
    // Solo al pasar a pagado.
  }, [paidSeen]);

  useEffect(() => {
    if (status === 'AUTHORIZING') setAuthorizingSince((since) => since ?? Date.now());
  }, [status]);

  // Mientras se puede pagar, la cuenta atrás; caducado sin aviso del servidor, se ve igual.
  const now = useNow(isPreCobro(status));
  const shown = effectiveStatus(status, deadline, now);
  const open = !isFinalStatus(shown);
  useWakeLock(open);
  // En pantalla (esperando o con su resultado): si la sesión caduca, se entra encima sin perderlo.
  useOpenCharge('cobro', true, open);
  useHealthReport(
    `cobro:${payment.id}`,
    open
      ? {
          serverDown: !reachable,
          bankWaitingSinceMs: status === 'AUTHORIZING' ? authorizingSince : null,
          orphan: status === 'ORPHAN',
        }
      : {},
  );

  async function cancel() {
    setCanceling(true);
    setError(null);
    try {
      await cancelPayment(payment.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setCanceling(false);
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(payment.qrUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin portapapeles: el QR sigue en pantalla */
    }
  }

  const outcome = outcomeKindOf(shown);
  if (outcome && !(outcome === 'paid' && outcomeDismissed)) {
    return (
      <StaffOutcome
        key={outcome}
        kind={outcome}
        amountCents={payment.amountCents}
        currency={payment.currency}
        message={outcome === 'failed' && !isPos ? 'Que el cliente pruebe con otra tarjeta.' : undefined}
        detail={<OutcomeDetail label={label} tipCents={outcome === 'paid' ? tipCents : 0} />}
        // El cliente ve el mismo código en su móvil; con datáfono no hay móvil que comparar.
        code={outcome === 'paid' && !isPos ? confirmationCode(payment.id) : null}
        codeHint="Debe coincidir con el del móvil del cliente."
        {...outcomeActions(outcome, {
          isPos,
          hasWallet: Boolean(payment.walletId),
          onClose,
          onRetry,
          retrying,
          onShowWallet: () => setOutcomeDismissed(true),
        })}
        error={outcome === 'paid' ? null : retryError}
      />
    );
  }

  // POS_EXTERNAL: el QR no es para el cliente, es para que el camarero vea
  // el cobro pendiente. Mostramos código corto humano-legible.
  const refCode = payment.id.slice(-6).toUpperCase();
  const preCobro = isPreCobro(shown);

  return (
    <Card variant="glow" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ textAlign: 'center' }}>
        <p style={kicker}>{isPos ? 'Cobro POS' : 'Importe'}</p>
        <p className="np-num" style={amountBig}>
          {formatEurAmount(payment.amountCents)}{' '}
          <span style={{ fontSize: '0.95rem', color: 'var(--np-text-mute)', fontWeight: 500 }}>{payment.currency}</span>
        </p>
        {label ? <p style={{ margin: '0.25rem 0 0', fontWeight: 700, fontSize: '1.0625rem' }}>{label}</p> : null}
        {isPos ? (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.9375rem', color: 'var(--np-text-mute)' }}>
            Llama al camarero. Código: <strong style={refCodeStyle}>#{refCode}</strong>
          </p>
        ) : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <StatusPill status={shown} />
      </div>

      <QrCountdown deadline={preCobro ? deadline : null} nowMs={now}>
        <div style={qrBoxStyle}>
          <img
            src={payment.qrPngDataUrl}
            alt={isPos ? 'QR del cobro POS' : 'QR del cobro'}
            style={{ width: '100%', maxWidth: isPos ? '12rem' : '20rem', height: 'auto', display: 'block' }}
          />
        </div>
      </QrCountdown>
      {isPos ? (
        <div style={posNoteStyle}>
          <p style={{ margin: 0, fontSize: '0.9375rem', lineHeight: 1.6 }}>
            <strong>Camarero:</strong> escanea el QR con tu móvil (o usa código <strong style={refCodeStyle}>#{refCode}</strong>).
            <br />
            Cobra <strong>{formatEur(payment.amountCents)}</strong> en el datáfono, luego confirma en tu app.
          </p>
        </div>
      ) : (
        <Button onClick={() => void copyUrl()} variant="ghost" size="md">
          {copied ? '✓ Copiado' : 'Copiar link del cobro'}
        </Button>
      )}

      {shown === 'AUTHORIZED' ? (
        <PaidBlock payment={payment} tipCents={tipCents} onNew={onClose} />
      ) : preCobro ? (
        <Button onClick={() => void cancel()} variant="danger" size="md" loading={canceling}>
          Cancelar cobro
        </Button>
      ) : (
        <Button onClick={onClose} variant="ghost" size="md">
          Nuevo cobro
        </Button>
      )}

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.9375rem', textAlign: 'center' }}>
          {error}
        </p>
      ) : null}
    </Card>
  );
}

interface ActionContext {
  isPos: boolean;
  hasWallet: boolean;
  onClose: () => void;
  onRetry?: () => void;
  retrying: boolean;
  onShowWallet: () => void;
}

/** Los botones del resultado: seguir cobrando, o repetir el mismo cobro si no salió. */
function outcomeActions(
  kind: OutcomeKind,
  { isPos, hasWallet, onClose, onRetry, retrying, onShowWallet }: ActionContext,
): { primary: OutcomeAction; secondary?: OutcomeAction } {
  if (kind === 'paid') {
    // Recarga de saldo: falta darle su código (y su PIN o su ficha).
    return hasWallet
      ? { primary: { label: 'Seguir: código del saldo', onClick: onShowWallet } }
      : { primary: { label: 'Nuevo cobro', onClick: onClose } };
  }
  if (!onRetry) return { primary: { label: 'Nuevo cobro', onClick: onClose } };
  return {
    primary: {
      label: isPos ? 'Otro cobro · mismo importe' : 'Otro QR · mismo importe',
      onClick: onRetry,
      loading: retrying,
    },
    secondary: { label: 'Nuevo cobro', onClick: onClose, disabled: retrying },
  };
}

function OutcomeDetail({ label, tipCents }: { label: string | null; tipCents: number }) {
  if (!label && tipCents <= 0) return null;
  return (
    <>
      {label ? <p>{label}</p> : null}
      {tipCents > 0 ? <p className="np-num">+ {formatEur(tipCents, { compact: true })} de propina</p> : null}
    </>
  );
}

function PaidBlock({ payment, tipCents, onNew }: { payment: CreatedPayment; tipCents: number; onNew: () => void }) {
  return (
    <>
      <p style={{ ...kicker, textAlign: 'center' }}>
        Código de confirmación{' '}
        <strong className="np-num" style={{ fontSize: '1.5rem', color: 'var(--np-text)', letterSpacing: '0.2em' }}>
          {confirmationCode(payment.id)}
        </strong>
      </p>
      <p style={{ ...hintStyle, textAlign: 'center' }}>Debe coincidir con el del móvil del cliente.</p>
      {payment.walletId ? <NewWalletCard walletId={payment.walletId} /> : null}
      {tipCents > 0 ? (
        <p className="np-num" style={tipStyle}>
          + {formatEur(tipCents, { compact: true })} de propina
        </p>
      ) : null}
      <Button onClick={onNew} size="lg">
        ✓ Cobrado — nuevo
      </Button>
    </>
  );
}

/** Mismo código que ve el cliente en su pantalla "Pagado" (últimos 3 del id). */
function confirmationCode(paymentId: string): string {
  return paymentId.replace(/-/g, '').slice(-3).toUpperCase();
}

const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 700,
};

const amountBig: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '2.5rem',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  fontVariantNumeric: 'tabular-nums',
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
  lineHeight: 1.4,
};

const refCodeStyle: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  letterSpacing: '0.15em',
  color: 'var(--np-accent)',
};

const qrBoxStyle: CSSProperties = {
  background: 'white',
  borderRadius: 'var(--np-r-md)',
  padding: '0.75rem',
  display: 'flex',
  justifyContent: 'center',
};

const posNoteStyle: CSSProperties = {
  padding: '1rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px dashed var(--np-border)',
  textAlign: 'center',
};

const tipStyle: CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontWeight: 700,
  fontSize: '1.25rem',
  color: 'var(--np-accent)',
};
