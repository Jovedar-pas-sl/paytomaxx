'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card, StatusPill, type PaymentStatus } from '@nightpay/ui';
import { cancelPayment, type CreatedPayment } from '@/lib/api';
import { formatEur, formatEurAmount } from '@/lib/money';
import { advanceStatus } from '@/lib/payment-status';
import { NewWalletCard } from './NewWalletCard';
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
}

/**
 * El cobro recién creado: su QR, su estado en tiempo real (con sondeo de
 * respaldo) y la cuenta atrás. Sigue vivo aunque la chica cambie de pestaña.
 */
export function ActivePayment({ payment, isPos, label, onPaid, onClose }: Props) {
  const [status, setStatus] = useState<PaymentStatus>(payment.status as PaymentStatus);
  // Fase 1B — propina que eligió el cliente en su página de pago.
  const [tipCents, setTipCents] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [copied, setCopied] = useState(false);
  // La cuenta atrás empieza con la hora de ahora, no la de cuando se abrió la pantalla.
  const [now, setNow] = useState(() => Date.now());
  const [paidSeen, setPaidSeen] = useState(false);

  const connected = usePaymentLive(payment, (update) => {
    setStatus((current) => advanceStatus(current, update.status));
    if (update.tipCents !== undefined) setTipCents(update.tipCents);
    if (update.status === 'AUTHORIZED') setPaidSeen(true);
  });

  // Pagado (por el socket o por el sondeo, lo que llegue antes): una vez.
  useEffect(() => {
    if (paidSeen) onPaid();
    // Solo al pasar a pagado.
  }, [paidSeen]);

  const preCobro = status === 'CREATED' || status === 'AWAITING_CAPTURE';
  useEffect(() => {
    if (!preCobro) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [preCobro]);

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

  // POS_EXTERNAL: el QR no es para el cliente, es para que el camarero vea
  // el cobro pendiente. Mostramos código corto humano-legible.
  const refCode = payment.id.slice(-6).toUpperCase();
  const expiryMs = new Date(payment.qrExpiresAt).getTime();
  const secondsLeft = preCobro && Number.isFinite(expiryMs) ? Math.max(0, Math.floor((expiryMs - now) / 1000)) : null;

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
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--np-text-mute)' }}>
            Llama al camarero. Código: <strong style={refCodeStyle}>#{refCode}</strong>
          </p>
        ) : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <StatusPill status={status} />
      </div>

      {secondsLeft !== null && secondsLeft > 0 ? (
        <p style={{ ...countdownStyle, color: secondsLeft < 60 ? 'var(--np-warning)' : 'var(--np-text-mute)' }}>
          QR caduca en {Math.floor(secondsLeft / 60)}:{(secondsLeft % 60).toString().padStart(2, '0')}
        </p>
      ) : null}

      {!connected && preCobro ? <ReconnectingNote /> : null}

      <div style={qrBoxStyle}>
        <img
          src={payment.qrPngDataUrl}
          alt={isPos ? 'QR del cobro POS' : 'QR del cobro'}
          style={{ width: '100%', maxWidth: isPos ? '12rem' : '20rem', height: 'auto', display: 'block' }}
        />
      </div>
      {isPos ? (
        <div style={posNoteStyle}>
          <p style={{ margin: 0, fontSize: '0.875rem', lineHeight: 1.6 }}>
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

      {status === 'AUTHORIZED' ? (
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
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem', textAlign: 'center' }}>
          {error}
        </p>
      ) : null}
    </Card>
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

/** Sin tiempo real: el estado se sigue mirando (sondeo), pero se avisa. */
function ReconnectingNote() {
  return (
    <p role="status" style={reconnectingStyle}>
      <span aria-hidden style={blinkDotStyle} />
      Reconectando con el servidor…
    </p>
  );
}

/** Mismo código que ve el cliente en su pantalla "Pagado" (últimos 3 del id). */
function confirmationCode(paymentId: string): string {
  return paymentId.replace(/-/g, '').slice(-3).toUpperCase();
}

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  color: 'var(--np-text-mute)',
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

const countdownStyle: CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontSize: '0.875rem',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '0.02em',
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

const reconnectingStyle: CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontSize: '0.75rem',
  color: 'var(--np-warning)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
};

// Parpadeo con la animación np-fade-in de @nightpay/ui (ida y vuelta): sin un
// <style> dentro de un <p>, que no es HTML válido.
const blinkDotStyle: CSSProperties = {
  width: '0.5rem',
  height: '0.5rem',
  borderRadius: '50%',
  background: 'var(--np-warning)',
  animation: 'np-fade-in 0.6s ease-in-out infinite alternate',
};
