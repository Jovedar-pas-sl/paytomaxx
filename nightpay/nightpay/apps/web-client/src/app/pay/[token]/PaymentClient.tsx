'use client';

import { useEffect, useState } from 'react';
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
import { StripePaymentForm } from './StripePaymentForm';

interface Props {
  initial: PublicPaymentView;
  token: string;
}

export function PaymentClient({ initial, token }: Props) {
  const [payment, setPayment] = useState<PublicPaymentView>(initial);
  const [status, setStatus] = useState<PaymentStatus>(initial.status as PaymentStatus);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [wsDown, setWsDown] = useState(false);

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
  const isStripe =
    payment.provider === 'STRIPE' &&
    typeof payment.stripeClientSecret === 'string' &&
    typeof payment.stripePublishableKey === 'string';
  // Stripe-only: el PaymentElement debe seguir visible durante AUTHORIZING
  // (mientras stripe.confirmPayment esta corriendo). Si falla mostraremos
  // el error en el form en vez de hacer desaparecer todo.
  const showStripeForm = isStripe && (canPay || status === 'AUTHORIZING');

  return (
    <Stage>
      <StageMeta venue={payment.venueName} terminal={payment.terminalLabel} />

      <AmountDisplay
        amountCents={payment.amountCents}
        currency={payment.currency}
        status={status}
      />

      <StatusPill status={status} />

      {showStripeForm ? (
        <div style={{ width: '100%', maxWidth: '26rem' }}>
          <StripePaymentForm
            publishableKey={payment.stripePublishableKey as string}
            clientSecret={payment.stripeClientSecret as string}
            amountCents={payment.amountCents}
            currency={payment.currency}
            token={token}
            onError={(msg) => setError(msg)}
          />
        </div>
      ) : (
        <div style={{ minHeight: '4.5rem', display: 'flex', alignItems: 'center' }}>
          {canPay ? (
            <Button size="lg" onClick={handlePay} loading={submitting}>
              Pagar ahora
            </Button>
          ) : null}
        </div>
      )}

      {error ? (
        <p
          role="alert"
          style={{
            color: 'var(--np-danger)',
            margin: 0,
            maxWidth: '24rem',
            textAlign: 'center',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </p>
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

      <footer
        style={{
          marginTop: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        <span
          style={{
            fontSize: '0.6875rem',
            color: 'var(--np-text-dim)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          Powered by
        </span>
        <Logo height="1.75rem" />
      </footer>
    </Stage>
  );
}
