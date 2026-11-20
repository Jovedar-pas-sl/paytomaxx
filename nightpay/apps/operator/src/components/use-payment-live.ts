import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { PaymentStatus } from '@nightpay/contracts';
import { fetchPaymentStatus, freshAccessToken, ServerUnavailableError, wsBase } from '@/lib/api';
import { isFinalStatus, pollUpdate, type BitcoinLive, type PaidQrMethod } from '@/lib/payment-status';
import { createPaymentLive, type PaymentSocket } from '@nightpay/ui';
import { isPractice } from '@/lib/practice';
import { practiceSocket } from '@/lib/practice-sim';

export interface PaymentUpdate {
  status: PaymentStatus;
  /**
   * Propina que dejó el cliente: la traen el evento de pagado y el sondeo
   * (API nuevo, ya pagado). Sin ella (undefined), aún no se sabe: no es 0.
   */
  tipCents?: number;
  /** Esperando al banco: cuándo salió el intento (solo el sondeo, API nuevo). */
  attemptStartedAt?: string;
  /** Ya pagado (el sondeo): cómo pagó (tarjeta, Apple Pay / Google Pay o bitcoin), si el API lo dio. */
  payMethod?: PaidQrMethod;
  /**
   * Pagando (AUTHORIZING, solo el sondeo): el estado de su factura de bitcoin, o
   * null si paga en su banco. Sin la clave (el tiempo real), no se sabe: no cambia.
   */
  bitcoin?: BitcoinLive | null;
}

export interface PaymentLiveState {
  /** El tiempo real (socket) está conectado. */
  live: boolean;
  /** Se habla con el API: con el socket o, si está caído, con el sondeo (su última respuesta llegó). */
  reachable: boolean;
}

const isHidden = (): boolean => document.visibilityState === 'hidden';

/**
 * Sigue un cobro hasta que termina: tiempo real (socket) y, además, un sondeo
 * que pregunta a menudo cuando el socket está caído. Al (re)conectar se pide
 * el estado: un «pagado» emitido sin conexión no se pierde. Solo depende del
 * id del cobro: re-renders de la pantalla no tiran el socket.
 * Devuelve si el tiempo real está conectado y si se llega al API (para el
 * aviso de conexión de arriba).
 */
export function usePaymentLive(
  payment: { id: string; qrToken: string } | null,
  onUpdate: (update: PaymentUpdate) => void,
): PaymentLiveState {
  const [connected, setConnected] = useState(true);
  const [pollOk, setPollOk] = useState(true);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  });

  const id = payment?.id ?? null;
  const qrToken = payment?.qrToken ?? null;

  useEffect(() => {
    if (!id || !qrToken) return undefined;
    let final = false;
    // El cliente está en su banco: el respaldo pregunta cada 4 s, no cada 10 s.
    let authorizing = false;
    // Cerrado por nosotros (otro cobro, pantalla fuera): nada de reconectar.
    let closed = false;
    setConnected(true);
    setPollOk(true);

    const emit = (update: PaymentUpdate) => {
      if (isFinalStatus(update.status)) final = true;
      authorizing = update.status === 'AUTHORIZING';
      onUpdateRef.current(update);
    };

    const live = createPaymentLive({
      paymentId: id,
      isHidden,
      isAuthorizing: () => authorizing,
      onLiveChange: (isLive) => {
        if (!closed) setConnected(isLive);
      },
      poll: async (signal) => {
        if (final) return 'stop';
        try {
          const current = await fetchPaymentStatus(qrToken, signal);
          if (!closed) setPollOk(true);
          const update = pollUpdate(current, id);
          if (update) emit(update);
        } catch (err) {
          // Sin respuesta, 5xx o 429: el API no contesta (otro error no dice eso).
          if (!closed && err instanceof ServerUnavailableError) setPollOk(false);
          throw err;
        }
        return final ? 'stop' : undefined;
      },
      socket: () => {
        // En práctica, un socket de mentira: un cobro real no puede salir ni marcarse aquí.
        const socket = isPractice() ? (practiceSocket() as unknown as ReturnType<typeof io>) : io(`${wsBase}/rt`, {
          // Si el WebSocket no conecta (proxy, wifi del local), cae a polling HTTP.
          transports: ['websocket', 'polling'],
          tryAllTransports: true,
          // El JWT de quien cobra en el handshake: en cada (re)conexión, el vigente.
          auth: (cb) => {
            void freshAccessToken().then((token) => cb(token ? { token } : {}));
          },
        });
        socket.on('payment:update', (e: { paymentId: string; status: PaymentStatus }) => {
          if (e.paymentId !== id) return;
          emit({ status: e.status });
          // Salió al banco (o se quedó sin su respuesta): el sondeo trae desde cuándo.
          if (e.status === 'AUTHORIZING' || e.status === 'ORPHAN') live.poke();
        });
        socket.on('payment:completed', (e: { paymentId: string; status: PaymentStatus; tipCents?: number }) => {
          if (e.paymentId === id) emit({ status: e.status, tipCents: e.tipCents ?? 0 });
        });
        return socket as unknown as PaymentSocket;
      },
    });

    const poke = () => live.poke();
    const onVisibility = () => {
      if (!isHidden()) poke();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Vuelve la red (cobertura recuperada): se pregunta ya, sin esperar a la siguiente vuelta.
    window.addEventListener('online', poke);
    live.start();

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', poke);
      live.stop();
    };
  }, [id, qrToken]);

  return { live: connected, reachable: connected || pollOk };
}
