'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { fetchServices, type ServiceItem } from '@/lib/api';

export interface Carta {
  services: ServiceItem[];
  /** No se pudo cargar: se cobra tecleando el importe y se ofrece reintentar. */
  failed: boolean;
  retry: () => void;
}

/** La carta del local (lo que quien llama puede cobrar). */
export function useCarta(): Carta {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchServices()
      .then((list) => {
        if (cancelled) return;
        setServices(list);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { services, failed, retry };
}

/** Aviso pequeño cuando la carta no llegó (antes se tragaba el error en silencio). */
export function CartaRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="status" style={noteStyle}>
      No se pudo cargar la carta: teclea el importe o{' '}
      <button type="button" onClick={onRetry} style={retryBtnStyle}>
        reintentar
      </button>
      .
    </p>
  );
}

/** Nombre del servicio y, si no lo dice ya el nombre, su duración. */
export function serviceLabel(svc: ServiceItem): string {
  return svc.durationMin && !svc.name.includes(String(svc.durationMin))
    ? `${svc.name} · ${svc.durationMin} min`
    : svc.name;
}

const noteStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--np-warning)',
  textAlign: 'center',
};

const retryBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: 'var(--np-accent)',
  fontWeight: 700,
  textDecoration: 'underline',
  cursor: 'pointer',
};
