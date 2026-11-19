'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { fetchServices, freshAccessToken, setServiceSoldOut, wsBase, type ServiceItem } from '@/lib/api';
import { CARTA_START, cartaArrived, cartaFailed, type CartaState } from '@/lib/carta-state';

export interface Carta {
  services: ServiceItem[];
  /** No se pudo cargar: se cobra tecleando el importe y se ofrece reintentar. */
  failed: boolean;
  /** Ya contestó (con servicios, sin ninguno o con error): hasta entonces no se pinta ni carta ni teclado. */
  loaded: boolean;
  retry: () => void;
  /** Marca o quita «Agotado» (el aviso a los demás móviles lo manda el servidor). */
  setSoldOut: (id: string, soldOut: boolean) => Promise<void>;
}

/** La carta del local (lo que quien llama puede cobrar). */
export function useCarta(): Carta {
  // Un solo estado: un refetch que falla con la carta ya a la vista, o que trae
  // la misma, deja el mismo objeto y no vuelve a pintar nada (lib/carta-state).
  // Pedirla otra vez tampoco pinta: solo cuenta la última petición (una ref).
  const [state, setState] = useState<CartaState>(CARTA_START);
  const latest = useRef(0);

  const retry = useCallback(() => {
    latest.current += 1;
    const mine = latest.current;
    fetchServices()
      .then((list) => {
        if (latest.current === mine) setState((prev) => cartaArrived(prev, list));
      })
      .catch(() => {
        if (latest.current === mine) setState((prev) => cartaFailed(prev));
      });
  }, []);

  useEffect(() => {
    retry();
    // Al desmontar, ninguna respuesta pendiente llega ya a la pantalla.
    return () => {
      latest.current += 1;
    };
  }, [retry]);
  // Al volver desde el panel, volver a pedir la carta del puesto: puede haberse
  // configurado mientras esta pestaña seguía abierta con la lista vacía.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('focus', retry);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', retry);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [retry]);
  // «Agotado» cambia en otro móvil: el servidor avisa y se vuelve a pedir la carta.
  useEffect(() => {
    const socket = io(`${wsBase}/rt`, {
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      auth: (cb) => {
        void freshAccessToken().then((token) => cb(token ? { token } : {}));
      },
    });
    socket.on('carta:update', retry);
    return () => {
      socket.disconnect();
    };
  }, [retry]);
  const setSoldOut = useCallback(
    async (id: string, soldOut: boolean) => {
      try {
        await setServiceSoldOut(id, soldOut);
      } finally {
        retry();
      }
    },
    [retry],
  );
  const { services, failed, loaded } = state;
  return useMemo(() => ({ services, failed, loaded, retry, setSoldOut }), [services, failed, loaded, retry, setSoldOut]);
}
