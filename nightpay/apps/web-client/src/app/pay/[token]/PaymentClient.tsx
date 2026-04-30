'use client';

import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { fetchPaymentByToken, startAuthorization, wsBase, type PublicPaymentView } from '@/lib/api';

interface Props {
  initial: PublicPaymentView;
  token: string;
}

type UiStatus =
  | 'CREATED'
  | 'AWAITING_CAPTURE'
  | 'AUTHORIZING'
  | 'AUTHORIZED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'ORPHAN';

export function PaymentClient({ initial, token }: Props) {
  const [payment, setPayment] = useState<PublicPaymentView>(initial);
  const [status, setStatus] = useState<UiStatus>(initial.status as UiStatus);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [wsDown, setWsDown] = useState(false);

  // Conexion WebSocket — escucha updates del backend
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
        (e: { paymentId: string; status: UiStatus; amountCents: number }) => {
          if (e.paymentId === initial.id) setStatus(e.status);
        },
      );
      socket.on(
        'payment:completed',
        (e: { paymentId: string; status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED' }) => {
          if (e.paymentId === initial.id) setStatus(e.status);
        },
      );
    } catch (err) {
      setWsDown(true);
      // eslint-disable-next-line no-console
      console.error('ws connect failed', err);
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
        setStatus(fresh.status as UiStatus);
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
        .catch(() => {
          /* ignore */
        });
    }
    return () => {
      lock?.release().catch(() => {});
    };
  }, []);

  async function handlePay() {
    setSubmitting(true);
    setError(null);
    try {
      await startAuthorization(token);
      // El estado pasa a AUTHORIZING via WS
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  const amount = (payment.amountCents / 100).toFixed(2);

  return (
    <main style={pageStyle}>
      <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <p style={{ color: '#888', fontSize: '0.9rem', margin: 0 }}>{payment.venueName}</p>
        <p style={{ color: '#888', fontSize: '0.8rem', margin: 0 }}>{payment.terminalLabel}</p>
      </header>

      <div style={amountBoxStyle}>
        <span style={amountStyle}>{amount}</span>
        <span style={currencyStyle}>{payment.currency}</span>
      </div>

      <StatusView status={status} wsDown={wsDown} />

      {(status === 'CREATED' || status === 'AWAITING_CAPTURE') && (
        <button onClick={handlePay} disabled={submitting} style={primaryBtnStyle}>
          {submitting ? 'Procesando…' : 'Pagar ahora'}
        </button>
      )}

      {error && (
        <p style={{ color: '#ff5252', marginTop: '1rem', maxWidth: '24rem', textAlign: 'center' }}>
          {error}
        </p>
      )}

      {wsDown && (
        <p style={{ color: '#ffb74d', marginTop: '0.5rem', fontSize: '0.8rem' }}>
          Conexión en vivo caída — sincronizando cada 3s.
        </p>
      )}
    </main>
  );
}

function StatusView({ status }: { status: UiStatus; wsDown: boolean }) {
  const map: Record<UiStatus, { label: string; color: string; spin?: boolean }> = {
    CREATED: { label: 'Esperando confirmación', color: '#aaa' },
    AWAITING_CAPTURE: { label: 'Esperando datáfono', color: '#aaa' },
    AUTHORIZING: { label: 'Acerca tarjeta al datáfono…', color: '#4fc3f7', spin: true },
    AUTHORIZED: { label: '✓ Pago completado', color: '#66bb6a' },
    FAILED: { label: '✗ Pago rechazado', color: '#ef5350' },
    EXPIRED: { label: 'QR expirado', color: '#ffa726' },
    REFUNDED: { label: 'Pago reembolsado', color: '#ab47bc' },
    PARTIALLY_REFUNDED: { label: 'Reembolsado parcial', color: '#ab47bc' },
    ORPHAN: { label: 'Verificando…', color: '#ffa726', spin: true },
  };
  const v = map[status];
  return (
    <div style={{ marginTop: '2rem', textAlign: 'center', minHeight: '3rem' }}>
      {v.spin && <span style={{ display: 'inline-block', marginRight: '0.5rem' }}>⟳</span>}
      <span style={{ color: v.color, fontSize: '1.1rem', fontWeight: 500 }}>{v.label}</span>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem 1rem',
};

const amountBoxStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.5rem',
};
const amountStyle: React.CSSProperties = { fontSize: '4rem', fontWeight: 700, lineHeight: 1 };
const currencyStyle: React.CSSProperties = { fontSize: '1.5rem', color: '#888' };

const primaryBtnStyle: React.CSSProperties = {
  marginTop: '2rem',
  padding: '1rem 2.5rem',
  fontSize: '1.1rem',
  fontWeight: 600,
  background: '#fafafa',
  color: '#0b0b10',
  border: 'none',
  borderRadius: '999px',
  cursor: 'pointer',
};

// Wake Lock API ya esta tipada en lib.dom.d.ts en versiones recientes de TS.
// Quitamos el override manual que chocaba con `readonly wakeLock`.
