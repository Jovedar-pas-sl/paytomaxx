import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  advanceStatus,
  createPaymentLive,
  isFinalStatus,
  isPolledPayment,
  type PaymentLive,
  type PaymentSocket,
  type PaymentStatus,
} from '@nightpay/ui';
import { fetchPaymentStatus, freshAccessToken, wsBase, type CreatedPayment } from './api';
import { playBeep } from './beep';

export interface LivePaymentStatus {
  status: PaymentStatus | null;
  /** null: conectando; false: sin conexión en directo (el estado puede no moverse). */
  live: boolean | null;
  /** Se llega al API: con el socket o con la última respuesta del sondeo. */
  reachable: boolean;
  /** Preguntar ya al servidor (p. ej. pasado el plazo del QR, a la espera del «caducado»). */
  checkNow: () => void;
}

const isHidden = (): boolean => document.visibilityState === 'hidden';

/**
 * Estado del cobro: tiempo real por el WebSocket /rt del API y, además, un
 * sondeo de respaldo (a menudo sin socket). Al (re)conectar se pide el estado:
 * un «pagado» emitido sin conexión no se pierde. El estado nunca va hacia
 * atrás (un evento tardío no deshace un pagado). Pita una vez al pagarse.
 */
export function usePaymentStatus(payment: CreatedPayment | null): LivePaymentStatus {
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [pollOk, setPollOk] = useState(true);
  const pollerRef = useRef<PaymentLive | null>(null);

  const id = payment?.id ?? null;
  const qrToken = payment?.qrToken ?? null;
  const initial = (payment?.status as PaymentStatus | undefined) ?? null;

  useEffect(() => {
    setStatus(initial);
    setLive(null);
    setPollOk(true);
    if (!id || !qrToken) return undefined;
    let final = initial !== null && isFinalStatus(initial);
    let beeped = false;
    let closed = false;

    const emit = (next: PaymentStatus) => {
      if (closed) return;
      if (isFinalStatus(next)) final = true;
      setStatus((current) => advanceStatus(current, next));
      if (next === 'AUTHORIZED' && !beeped) {
        beeped = true;
        playBeep();
      }
    };

    const link = createPaymentLive({
      paymentId: id,
      isHidden,
      onLiveChange: (isLive) => {
        if (!closed) setLive(isLive);
      },
      poll: async (signal) => {
        if (final) return 'stop';
        try {
          const current = await fetchPaymentStatus(qrToken, signal);
          if (!closed) setPollOk(true);
          if (isPolledPayment(current, id)) emit(current.status);
        } catch (err) {
          if (!closed) setPollOk(false);
          throw err;
        }
        return final ? 'stop' : undefined;
      },
      socket: () => {
        const socket = io(`${wsBase}/rt`, {
          // Si el WebSocket no conecta (proxy, wifi del local), cae a polling HTTP.
          transports: ['websocket', 'polling'],
          tryAllTransports: true,
          // El API pide el JWT del personal. Función: en cada reconexión el token
          // del momento (renovado si está a punto de caducar), no el del primer intento.
          auth: (cb) => {
            void freshAccessToken().then((token) => cb(token ? { token } : {}));
          },
        });
        socket.on('payment:update', (e: { paymentId: string; status: PaymentStatus }) => {
          if (e.paymentId === id) emit(e.status);
        });
        socket.on('payment:completed', (e: { paymentId: string; status: PaymentStatus }) => {
          if (e.paymentId === id) emit(e.status);
        });
        return socket as unknown as PaymentSocket;
      },
    });
    pollerRef.current = link;

    const poke = () => link.poke();
    const onVisibility = () => {
      if (!isHidden()) poke();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Vuelve la red (cobertura recuperada): se pregunta ya.
    window.addEventListener('online', poke);
    link.start();

    return () => {
      closed = true;
      pollerRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', poke);
      link.stop();
    };
  }, [id, qrToken, initial]);

  const checkNow = useCallback(() => pollerRef.current?.poke(), []);
  return { status, live, reachable: live === true || pollOk, checkNow };
}
