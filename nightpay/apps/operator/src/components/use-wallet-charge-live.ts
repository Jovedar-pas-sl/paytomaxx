import { useCallback, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { freshAccessToken, wsBase } from '@/lib/api';
import type { PollOutcome } from '@/lib/poller';
import { isPractice } from '@/lib/practice';
import { practiceSocket } from '@/lib/practice-sim';
import { WALLET_CHARGE_POLL_OFFLINE_MS, createWalletChargeLive, type ChargeSocket, type WalletChargeLive } from '@/lib/wallet-charge-live';

export interface WalletChargeLiveOptions {
  /** false: parado (p. ej. ya no se espera nada). */
  enabled?: boolean;
  /** Primera consulta de respaldo (al conectar el tiempo real se pregunta antes). */
  firstCheckMs?: number;
  /** Pausa tras una consulta fallida (servidor caído, 429). */
  slowIntervalMs?: number;
}

const isHidden = (): boolean => document.visibilityState === 'hidden';

/**
 * Sigue un cobro del saldo al momento (lib/wallet-charge-live.ts): el aviso
 * `wallet-charge:update` por el tiempo real y, de respaldo, una consulta cada
 * 10 s (4 s sin tiempo real). `task` es la consulta de siempre (usa siempre la
 * última versión). Devuelve cómo preguntar ya, como usePolling.
 */
export function useWalletChargeLive(
  chargeId: string | null,
  task: (signal: AbortSignal) => Promise<PollOutcome>,
  { enabled = true, firstCheckMs = WALLET_CHARGE_POLL_OFFLINE_MS, slowIntervalMs }: WalletChargeLiveOptions = {},
): () => void {
  const taskRef = useRef(task);
  const liveRef = useRef<WalletChargeLive | null>(null);

  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    if (!chargeId || !enabled) return undefined;
    const live = createWalletChargeLive({
      chargeId,
      poll: (signal) => taskRef.current(signal),
      socket: () =>
        // En práctica, un socket de mentira (ningún aviso real entra).
        (isPractice() ? practiceSocket() : io(`${wsBase}/rt`, {
          // Si el WebSocket no conecta (proxy, wifi del local), cae a polling HTTP.
          transports: ['websocket', 'polling'],
          tryAllTransports: true,
          // El JWT de quien cobra en el handshake: en cada (re)conexión, el vigente.
          auth: (cb) => {
            void freshAccessToken().then((token) => cb(token ? { token } : {}));
          },
        })) as unknown as ChargeSocket,
      isHidden,
      slowIntervalMs,
    });
    liveRef.current = live;
    const onVisibility = () => {
      if (!isHidden()) live.poke();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Vuelve la red (cobertura recuperada): se pregunta ya.
    const onOnline = () => live.poke();
    window.addEventListener('online', onOnline);
    live.start(firstCheckMs);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      live.stop();
      if (liveRef.current === live) liveRef.current = null;
    };
  }, [chargeId, enabled, firstCheckMs, slowIntervalMs]);

  return useCallback(() => liveRef.current?.poke(), []);
}
