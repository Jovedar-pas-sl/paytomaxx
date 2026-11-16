import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { CustomerScreenView } from '@nightpay/contracts';
import { createPoller } from '@nightpay/ui';
import { wsBase } from '@/lib/api';
import { DisplayApiError, fetchScreen } from '@/lib/customer-display-api';

/** Con el tiempo real conectado, preguntar es solo una red de seguridad. */
export const SCREEN_POLL_LIVE_MS = 15_000;
/** Sin tiempo real (wifi del local, servidor reiniciando): más a menudo, pero sin agobiar. */
export const SCREEN_POLL_OFFLINE_MS = 5_000;
/** El servidor cerró la conexión (despliegue, otra tablet): se reconecta después. */
const RECONNECT_MS = 10_000;
/** Avisos tras los que la tablet vuelve a preguntar qué enseñar (no lee nada de ellos). */
const POKE_EVENTS = ['display:update', 'payment:update', 'payment:completed', 'wallet-charge:update'] as const;

const isHidden = (): boolean => document.visibilityState === 'hidden';

/**
 * Lo que enseña la tablet, al momento: el tiempo real (socket, con la
 * credencial de la pantalla) solo avisa de que algo cambió y entonces se
 * pregunta al API; de respaldo, cada 15 s (cada 5 s sin tiempo real). Un 401
 * es que se desemparejó (o caducó): `onUnpaired`. `refresh` pregunta ya
 * (tras elegir propina o pagar con la ficha en la tablet).
 */
export function usePantallaLive(
  token: string | null,
  onView: (view: CustomerScreenView) => void,
  onUnpaired: () => void,
): { live: boolean; reachable: boolean; refresh: () => void } {
  const [live, setLive] = useState(false);
  const pokeRef = useRef<() => void>(() => undefined);
  const [reachable, setReachable] = useState(true);
  const onViewRef = useRef(onView);
  const onUnpairedRef = useRef(onUnpaired);
  useEffect(() => {
    onViewRef.current = onView;
    onUnpairedRef.current = onUnpaired;
  });

  useEffect(() => {
    if (!token) return undefined;
    let closed = false;
    let connected = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const poller = createPoller({
      task: async (signal) => {
        try {
          const view = await fetchScreen(signal);
          if (closed) return 'stop';
          setReachable(true);
          onViewRef.current(view);
          return undefined;
        } catch (err) {
          if (closed) return 'stop';
          if (err instanceof DisplayApiError && err.status === 401) {
            onUnpairedRef.current();
            return 'stop';
          }
          setReachable(false);
          return 'slow';
        }
      },
      intervalMs: () => (connected ? SCREEN_POLL_LIVE_MS : SCREEN_POLL_OFFLINE_MS),
      slowIntervalMs: SCREEN_POLL_OFFLINE_MS,
      isHidden,
    });
    const poke = () => poller.poke();
    pokeRef.current = poke;

    const socket = io(`${wsBase}/rt`, {
      // Si el WebSocket no conecta (proxy, wifi del local), cae a polling HTTP.
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      auth: { displayToken: token },
    });
    const setConnected = (next: boolean) => {
      connected = next;
      if (!closed) setLive(next);
    };
    socket.on('connect', () => {
      setConnected(true);
      poke();
    });
    socket.on('disconnect', () => {
      setConnected(false);
      // Un aviso pudo perderse justo ahora; y si fue el servidor (desemparejada), la consulta lo dirá.
      poke();
      if (!socket.active && retry === null) {
        retry = setTimeout(() => {
          retry = null;
          if (!closed) socket.connect();
        }, RECONNECT_MS);
      }
    });
    socket.on('connect_error', () => setConnected(false));
    for (const event of POKE_EVENTS) socket.on(event, poke);

    const onVisibility = () => {
      if (!isHidden()) poke();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', poke);
    poller.start(0);

    return () => {
      closed = true;
      if (retry !== null) clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', poke);
      poller.stop();
      socket.disconnect();
      pokeRef.current = () => undefined;
    };
  }, [token]);

  const refresh = useCallback(() => pokeRef.current(), []);
  return { live, reachable, refresh };
}
