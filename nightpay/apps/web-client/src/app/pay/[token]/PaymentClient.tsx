'use client';

import { useEffect, useMemo, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  AmountDisplay,
  Button,
  Logo,
  Stage,
  StageMeta,
  StatusPill,
  type PaymentStatus,
} from '@nightpay/ui';
import { fetchPaymentByToken, startAuthorization, wsBase, type PublicPaymentView } from '@/lib/api';

interface Props {
  initial: PublicPaymentView;
  token: string;
}

const TERMINAL_STATES: PaymentStatus[] = [
  'AUTHORIZED',
  'FAILED',
  'EXPIRED',
  'CANCELED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
];

export function PaymentClient({ initial, token }: Props) {
  const [payment, setPayment] = useState<PublicPaymentView>(initial);
  const [status, setStatus] = useState<PaymentStatus>(initial.status as PaymentStatus);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [wsDown, setWsDown] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick global cada segundo para countdown del QR (sin re-render del resto
  // mientras la página está estable — useState con setNow es suficiente).
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let socket: Socket | null = null;
    try {
      socket = io(`${wsBase}/rt`, { transports: ['websocket', 'polling'] });
      socket.on('connect', () => {
        setWsDown(false);
        socket?.emit('payment:subscribe', { paymentId: initial.id });
      });
      socket.on('disconnect', () => setWsDown(true));
      socket.on(
        'payment:update',
        (e: { paymentId: string; status: PaymentStatus; amountCents: number }) => {
          if (e.paymentId === initial.id) setStatus(e.status);
        },
      );
      socket.on(
        'payment:completed',
        (e: { paymentId: string; status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED' }) => {
          if (e.paymentId === initial.id) setStatus(e.status);
        },
      );
    } catch {
      setWsDown(true);
    }
    return () => {
      socket?.disconnect();
    };
  }, [initial.id]);

  // Fallback polling cuando WS cae
  useEffect(() => {
    if (!wsDown) return;
    const interval = setInterval(async () => {
      try {
        const fresh = await fetchPaymentByToken(token);
        setPayment(fresh);
        setStatus(fresh.status as PaymentStatus);
      } catch {
        // ignore — el polling sigue
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [wsDown, token]);

  // Wake lock — mantener pantalla encendida durante el pago
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    if ('wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((l) => (lock = l))
        .catch(() => {});
    }
    return () => {
      lock?.release().catch(() => {});
    };
  }, []);

  async function handlePay() {
    if ('vibrate' in navigator) navigator.vibrate(15);
    setSubmitting(true);
    setError(null);
    try {
      await startAuthorization(token);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  const canPay = status === 'CREATED' || status === 'AWAITING_CAPTURE';
  const isAuthorized = status === 'AUTHORIZED';
  const isTerminal = TERMINAL_STATES.includes(status);

  // Countdown del QR — sólo mostrar si está en estado pre-pago y queda <2min
  const secondsLeft = useMemo(() => {
    if (!payment.qrExpiresAt) return null;
    const exp = new Date(payment.qrExpiresAt).getTime();
    if (!Number.isFinite(exp)) return null;
    return Math.max(0, Math.floor((exp - now) / 1000));
  }, [payment.qrExpiresAt, now]);

  const showCountdown =
    canPay && secondsLeft !== null && secondsLeft > 0 && secondsLeft < 120;

  // Si llegamos a AUTHORIZED, vibración celebración + scroll arriba
  useEffect(() => {
    if (isAuthorized && 'vibrate' in navigator) {
      navigator.vibrate([40, 60, 40, 60, 80]);
    }
  }, [isAuthorized]);

  // ─── Estado AUTHORIZED: pantalla de éxito full-screen ────────────
  if (isAuthorized) {
    return (
      <Stage>
        <SuccessCheck />
        <h1
          style={{
            margin: '1rem 0 0.5rem',
            fontSize: '2rem',
            color: 'var(--np-success)',
            textAlign: 'center',
            fontWeight: 700,
          }}
        >
          ¡Pagado!
        </h1>
        <AmountDisplay
          amountCents={payment.amountCents}
          currency={payment.currency}
          status={status}
        />
        <p
          style={{
            margin: '1rem 0 0',
            textAlign: 'center',
            color: 'var(--np-text)',
            fontSize: '1.05rem',
          }}
        >
          Tu pago se ha realizado correctamente.
        </p>
        <p
          style={{
            margin: '0.5rem 0 2rem',
            textAlign: 'center',
            color: 'var(--np-text-mute)',
            fontSize: '0.95rem',
          }}
        >
          Ya puedes cerrar esta pantalla.
        </p>
        {payment.venueName ? (
          <p
            style={{
              margin: 0,
              textAlign: 'center',
              color: 'var(--np-text-mute)',
              fontSize: '0.875rem',
              letterSpacing: '0.05em',
            }}
          >
            Gracias por visitar <strong>{payment.venueName}</strong>
          </p>
        ) : null}
        <SecureFooter />
      </Stage>
    );
  }

  return (
    <Stage>
      <StageMeta venue={payment.venueName} terminal={payment.terminalLabel} />

      <AmountDisplay
        amountCents={payment.amountCents}
        currency={payment.currency}
        status={status}
      />

      <StatusPill status={status} perspective="client" />

      {showCountdown ? (
        <p
          style={{
            margin: 0,
            color: secondsLeft !== null && secondsLeft < 30
              ? 'var(--np-warning)'
              : 'var(--np-text-mute)',
            fontSize: '0.875rem',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.02em',
          }}
        >
          Este cobro caduca en {formatCountdown(secondsLeft)}
        </p>
      ) : null}

      <div style={{ minHeight: '4.5rem', display: 'flex', alignItems: 'center' }}>
        {canPay ? (
          <Button size="lg" onClick={handlePay} loading={submitting}>
            Pagar ahora
          </Button>
        ) : isTerminal ? (
          <p
            style={{
              margin: 0,
              color: 'var(--np-text-mute)',
              fontSize: '1rem',
              textAlign: 'center',
              maxWidth: '20rem',
            }}
          >
            {status === 'EXPIRED' || status === 'CANCELED'
              ? 'Pide a la chica un cobro nuevo.'
              : 'Pide a la chica que repita el cobro.'}
          </p>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          style={{
            margin: '0 1rem',
            padding: '0.875rem 1rem',
            borderRadius: 'var(--np-r-md)',
            background: 'var(--np-pill-danger-bg)',
            border: '1px solid var(--np-danger)',
            color: 'var(--np-danger)',
            fontSize: '1rem',
            lineHeight: 1.4,
            maxWidth: '24rem',
            textAlign: 'center',
          }}
        >
          {error}
        </div>
      ) : null}

      {wsDown ? (
        <p
          style={{
            color: 'var(--np-warning)',
            margin: 0,
            fontSize: '0.75rem',
            letterSpacing: '0.02em',
          }}
        >
          Conexión en vivo caída — sincronizando cada 3s
        </p>
      ) : null}

      <SecureFooter />
    </Stage>
  );
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function SuccessCheck() {
  return (
    <div
      aria-hidden
      style={{
        width: '6rem',
        height: '6rem',
        borderRadius: '50%',
        background: 'var(--np-pill-success-bg)',
        border: '3px solid var(--np-success)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'np-check-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}
    >
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M5 13l4 4L19 7"
          stroke="var(--np-success)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <style>{`
        @keyframes np-check-pop {
          0%   { transform: scale(0); opacity: 0; }
          60%  { transform: scale(1.1); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function SecureFooter() {
  return (
    <footer
      style={{
        marginTop: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.5rem',
        paddingTop: '1.5rem',
      }}
    >
      <span
        style={{
          fontSize: '0.75rem',
          color: 'var(--np-text-mute)',
          letterSpacing: '0.04em',
          display: 'flex',
          alignItems: 'center',
          gap: '0.375rem',
        }}
      >
        <LockIcon />
        Pago seguro
      </span>
      <Logo height="1.5rem" />
    </footer>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="4"
        y="11"
        width="16"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M8 11V7a4 4 0 018 0v4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
