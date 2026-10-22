'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { fetchServices, type ServiceItem } from '@/lib/api';
import { formatEur } from '@/lib/money';

export interface Carta {
  services: ServiceItem[];
  /** No se pudo cargar: se cobra tecleando el importe y se ofrece reintentar. */
  failed: boolean;
  /** Ya contestó (con servicios, sin ninguno o con error): hasta entonces no se pinta ni carta ni teclado. */
  loaded: boolean;
  retry: () => void;
}

/** La carta del local (lo que quien llama puede cobrar). */
export function useCarta(): Carta {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchServices()
      .then((list) => {
        if (cancelled) return;
        setServices(list);
        setFailed(false);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
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
  return { services, failed, loaded, retry };
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

/**
 * Un servicio de la carta (el borde, del color de su sección). «Copa con
 * invitación» es uno más: al tocarlo se escanea el QR de la chica.
 */
export function CartaTile({
  svc,
  color,
  disabled,
  onPick,
}: {
  svc: ServiceItem;
  color: string;
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onPick} style={{ ...tileStyle, borderLeft: `0.5rem solid ${color}` }}>
      <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>{serviceLabel(svc)}</span>
      <span className="np-num" style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--np-accent)' }}>
        {formatEur(svc.priceCents, { compact: true })}
      </span>
    </button>
  );
}

export const tileStyle: CSSProperties = {
  minHeight: '6rem',
  padding: '0.875rem',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '0.5rem',
  textAlign: 'left',
  background: 'var(--np-surface-2)',
  border: '2px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-lg)',
  color: 'var(--np-text)',
  cursor: 'pointer',
};

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
