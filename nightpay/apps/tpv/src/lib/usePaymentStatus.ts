import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { PaymentStatus } from '@nightpay/ui';
import { getToken, wsBase, type CreatedPayment } from './api';
import { playBeep } from './beep';

export interface LivePaymentStatus {
  status: PaymentStatus | null;
  /** null: conectando; false: sin conexión en directo (el estado puede no moverse). */
  live: boolean | null;
}

/** Estado en directo del cobro por el WebSocket /rt del API; pita cuando se paga. */
export function usePaymentStatus(payment: CreatedPayment | null): LivePaymentStatus {
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    setStatus(payment ? (payment.status as PaymentStatus) : null);
    setLive(null);
    if (!payment) return;

    const socket: Socket = io(`${wsBase}/rt`, {
      transports: ['websocket', 'polling'],
      // El API pide el JWT del personal. Función: en cada reconexión lee el
      // token del momento (ya refrescado), no el del primer intento.
      auth: (cb) => cb({ token: getToken() }),
    });
    socket.on('connect', () => {
      setLive(true);
      socket.emit('payment:subscribe', { paymentId: payment.id });
    });
    socket.on('disconnect', () => setLive(false));
    socket.on('connect_error', () => setLive(false));
    socket.on('payment:update', (e: { paymentId: string; status: PaymentStatus }) => {
      if (e.paymentId === payment.id) setStatus(e.status);
    });
    socket.on(
      'payment:completed',
      (e: { paymentId: string; status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED' }) => {
        if (e.paymentId !== payment.id) return;
        setStatus(e.status);
        if (e.status === 'AUTHORIZED') playBeep();
      },
    );
    return () => {
      socket.disconnect();
    };
  }, [payment]);

  return { status, live };
}
