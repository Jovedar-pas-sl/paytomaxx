import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { PaymentStatus } from '@nightpay/contracts';
import { fetchPaymentStatus, freshAccessToken, wsBase } from '@/lib/api';
import { isFinalStatus } from '@/lib/payment-status';
import { createPoller } from '@/lib/poller';

/** Con el tiempo real conectado, el sondeo es solo una red de seguridad. */
const POLL_LIVE_MS = 15_000;
/** Sin tiempo real (wifi del local, servidor reiniciando), se pregunta a menudo. */
const POLL_OFFLINE_MS = 4_000;
/** Plazo de cada consulta del estado: una colgada no deja de vigilar el cobro. */
const POLL_TIMEOUT_MS = 10_000;
/** El servidor cerró o rechazó la conexión (p. ej. token caducado): socket.io no reintenta solo. */
const RECONNECT_MS = 10_000;

export interface PaymentUpdate {
  status: PaymentStatus;
  /** Propina que dejó el cliente: solo la trae el evento de pagado. */
  tipCents?: number;
}

const isHidden = (): boolean => document.visibilityState === 'hidden';

/**
 * Sigue un cobro hasta que termina: tiempo real (socket) y, además, un sondeo
 * que pregunta a menudo cuando el socket está caído. Al (re)conectar se pide
 * el estado: un «pagado» emitido sin conexión no se pierde. Solo depende del
 * id del cobro: re-renders de la pantalla no tiran el socket.
 * Devuelve si el tiempo real está conectado (para el «Reconectando…»).
 */
export function usePaymentLive(
  payment: { id: string; qrToken: string } | null,
  onUpdate: (update: PaymentUpdate) => void,
): boolean {
  const [connected, setConnected] = useState(true);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  });

  const id = payment?.id ?? null;
  const qrToken = payment?.qrToken ?? null;

  useEffect(() => {
    if (!id || !qrToken) return undefined;
    let live = false;
    let final = false;
    // Cerrado por nosotros (otro cobro, pantalla fuera): nada de reconectar.
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    setConnected(true);

    const emit = (update: PaymentUpdate) => {
      if (isFinalStatus(update.status)) final = true;
      onUpdateRef.current(update);
    };

    const poller = createPoller({
      intervalMs: () => (live ? POLL_LIVE_MS : POLL_OFFLINE_MS),
      timeoutMs: POLL_TIMEOUT_MS,
      isHidden,
      task: async (signal) => {
        if (final) return 'stop';
        const current = await fetchPaymentStatus(qrToken, signal);
        if (current.id === id) emit({ status: current.status });
        return final ? 'stop' : undefined;
      },
    });

    const socket = io(`${wsBase}/rt`, {
      transports: ['websocket', 'polling'],
      // El JWT de quien cobra en el handshake: en cada (re)conexión, el vigente.
      auth: (cb) => {
        void freshAccessToken().then((token) => cb(token ? { token } : {}));
      },
    });
    const goOffline = () => {
      if (closed) return;
      live = false;
      setConnected(false);
      if (!socket.active && retry === null) {
        retry = setTimeout(() => {
          retry = null;
          if (!closed) socket.connect();
        }, RECONNECT_MS);
      }
    };
    socket.on('connect', () => {
      live = true;
      setConnected(true);
      socket.emit('payment:subscribe', { paymentId: id });
      poller.poke();
    });
    socket.on('disconnect', goOffline);
    socket.on('connect_error', goOffline);
    socket.on('payment:update', (e: { paymentId: string; status: PaymentStatus }) => {
      if (e.paymentId === id) emit({ status: e.status });
    });
    socket.on('payment:completed', (e: { paymentId: string; status: PaymentStatus; tipCents?: number }) => {
      if (e.paymentId === id) emit({ status: e.status, tipCents: e.tipCents ?? 0 });
    });

    const onVisibility = () => {
      if (!isHidden()) poller.poke();
    };
    document.addEventListener('visibilitychange', onVisibility);
    poller.start(POLL_OFFLINE_MS);

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (retry !== null) clearTimeout(retry);
      poller.stop();
      socket.disconnect();
    };
  }, [id, qrToken]);

  return connected;
}
