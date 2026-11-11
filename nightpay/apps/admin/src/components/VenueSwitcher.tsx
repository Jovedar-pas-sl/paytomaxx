'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { fetchAllVenues, type VenueListItem } from '@/lib/api';
import { useVenueSwitch } from './VenueSwitchDialog';

interface Props {
  currentSlug: string;
}

/**
 * Dropdown en el header. Solo se renderiza si user.isSuperAdmin=true.
 *
 * Al cambiar:
 *   1. POST /v1/auth/switch-tenant sin código: la 2FA se pidió al entrar
 *      (login en dos pasos). Solo una sesión de antes pide el código
 *      (VenueSwitchDialog). El API emite JWT nuevo y recuerda el local en la sesión
 *   2. lib/api.ts (switchToVenue) guarda token y local nuevos; las otras
 *      pestañas abiertas lo ven (evento storage) y se recargan también
 *   3. window.location.reload() para que toda la app cargue con contexto nuevo
 *
 * El refresh token sigue ligado al usuario; /refresh ya devuelve el token del
 * local elegido (el API lo guarda en la sesión). En el API, el super-admin se busca sin el filtro
 * por local (acrossVenues): con otro local activo no se le encontraba y
 * perdía el desplegable y el cambio de local.
 */
export function VenueSwitcher({ currentSlug }: Props) {
  const [venues, setVenues] = useState<VenueListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const switcher = useVenueSwitch();

  useEffect(() => {
    fetchAllVenues()
      .then(setVenues)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    // El desplegable sigue en el local actual hasta que se entra en el otro.
    const venue = venues.find((v) => v.id === e.target.value);
    if (venue) switcher.start(venue.id, venue.name);
  }

  if (loading) return null;
  // Sin lista no hay desplegable, pero el error se ve (antes se escondía).
  if (error && venues.length === 0) {
    return (
      <p role="alert" style={errStyle}>
        No se pudieron cargar los locales: {error}
      </p>
    );
  }
  if (venues.length <= 1) return null; // No vale la pena el dropdown si solo hay un local

  const currentVenue = venues.find((v) => v.slug === currentSlug);

  return (
    <div style={wrapperStyle}>
      <label htmlFor="np-venue-switch" style={labelStyle}>
        Local activo
      </label>
      <select
        id="np-venue-switch"
        value={currentVenue?.id ?? ''}
        onChange={onChange}
        disabled={switcher.busy}
        style={selectStyle}
      >
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      {error || switcher.error ? (
        <p role="alert" style={errStyle}>
          {switcher.error ?? error}
        </p>
      ) : null}
      {switcher.dialog}
    </div>
  );
}

const wrapperStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.15rem',
};

const labelStyle: CSSProperties = {
  fontSize: '0.875rem',
  color: 'var(--np-text-dim)',
  fontWeight: 400,
};

// Campo del panel: 36 px, radio 10 y filete de lo que se toca.
const selectStyle: CSSProperties = {
  height: '2.25rem',
  padding: '0 0.75rem',
  borderRadius: 'var(--np-r-sm)',
  border: '1px solid var(--np-border-hi)',
  background: 'var(--np-surface)',
  color: 'var(--np-text)',
  fontSize: '0.875rem',
  fontWeight: 400,
  cursor: 'pointer',
};

const errStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--np-danger-text)',
};
