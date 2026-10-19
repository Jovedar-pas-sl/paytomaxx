import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { advanceStatus, createPoller, isFinalStatus, type PaymentStatus, type Poller } from '@nightpay/ui';
import { fetchPaymentStatus, freshAccessToken, wsBase, type CreatedPayment } from './api';
import { playBeep } from './beep';

/** Con el tiempo real conectado, el sondeo es solo una red de seguridad. */
const POLL_LIVE_MS = 15_000;
/** Sin tiempo real, se pregunta a menudo. */
const POLL_FAST_MS = 4_000;
/** Plazo de cada consulta: una colgada no deja de vigilar el cobro. */
const POLL_TIMEOUT_MS = 10_000;
/** El servidor cerró o rechazó la conexión (p. ej. token caducado): socket.io no reintenta solo. */
const RECONNECT_MS = 10_000;

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
  const pollerRef = useRef<Poller | null>(null);

  const id = payment?.id ?? null;
  const qrToken = payment?.qrToken ?? null;
  const initial = (payment?.status as PaymentStatus | undefined) ?? null;

  useEffect(() => {
    setStatus(initial);
    setLive(null);
    setPollOk(true);
    if (!id || !qrToken) return undefined;
    let socketLive = false;
    let final = initial !== null && isFinalStatus(initial);
    let beeped = false;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const emit = (next: PaymentStatus) => {
      if (closed) return;
      if (isFinalStatus(next)) final = true;
      setStatus((current) => advanceStatus(current, next));
      if (next === 'AUTHORIZED' && !beeped) {
        beeped = true;
        playBeep();
      }
    };

    const poller = createPoller({
      intervalMs: () => (socketLive ? POLL_LIVE_MS : POLL_FAST_MS),
      timeoutMs: POLL_TIMEOUT_MS,
      isHidden,
      task: async (signal) => {
        if (final) return 'stop';
        try {
          const current = await fetchPaymentStatus(qrToken, signal);
          if (!closed) setPollOk(true);
          if (current.id === id) emit(current.status);
        } catch (err) {
          if (!closed) setPollOk(false);
          throw err;
        }
        return final ? 'stop' : undefined;
      },
    });
    pollerRef.current = poller;

    const socket: Socket = io(`${wsBase}/rt`, {
      transports: ['websocket', 'polling'],
      // El API pide el JWT del personal. Función: en cada reconexión el token
      // del momento (renovado si está a punto de caducar), no el del primer intento.
      auth: (cb) => {
        void freshAccessToken().then((token) => cb(token ? { token } : {}));
      },
    });
    const goOffline = () => {
      if (closed) return;
      socketLive = false;
      setLive(false);
      if (!socket.active && retry === null) {
        retry = setTimeout(() => {
          retry = null;
          if (!closed) socket.connect();
        }, RECONNECT_MS);
      }
    };
    socket.on('connect', () => {
      socketLive = true;
      setLive(true);
      socket.emit('payment:subscribe', { paymentId: id });
      // Lo que pasó mientras no había conexión: se pregunta ya.
      poller.poke();
    });
    socket.on('disconnect', goOffline);
    socket.on('connect_error', goOffline);
    socket.on('payment:update', (e: { paymentId: string; status: PaymentStatus }) => {
      if (e.paymentId === id) emit(e.status);
    });
    socket.on('payment:completed', (e: { paymentId: string; status: PaymentStatus }) => {
      if (e.paymentId === id) emit(e.status);
    });

    const onVisibility = () => {
      if (!isHidden()) poller.poke();
    };
    document.addEventListener('visibilitychange', onVisibility);
    poller.start(POLL_FAST_MS);

    return () => {
      closed = true;
      pollerRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      if (retry !== null) clearTimeout(retry);
      poller.stop();
      socket.disconnect();
    };
  }, [id, qrToken, initial]);

  const checkNow = useCallback(() => pollerRef.current?.poke(), []);
  return { status, live, reachable: live === true || pollOk, checkNow };
}
