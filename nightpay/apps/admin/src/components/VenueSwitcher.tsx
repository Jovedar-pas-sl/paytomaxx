'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { fetchAllVenues, switchTenant, type VenueListItem } from '@/lib/api';

interface Props {
  currentSlug: string;
}

/**
 * Dropdown en el header. Solo se renderiza si user.isSuperAdmin=true.
 *
 * Al cambiar:
 *   1. Llama POST /v1/auth/switch-tenant → API emite JWT nuevo
 *   2. Reemplaza el accessToken en localStorage
 *   3. window.location.reload() para que toda la app cargue con contexto nuevo
 *
 * Refresh token NO rota — sigue ligado al user original. Si el JWT expira
 * en 12h y el refresh hace su trabajo, el endpoint /refresh devuelve un
 * nuevo access con el tenantId PRIMARIO del user (el de su row en DB),
 * no el switcheado. Esto es intencional: el switch se vuelve a hacer
 * explícitamente para audit trail. En la práctica con TTL 12h funciona
 * para una sesión laboral completa sin re-switchear.
 */
export function VenueSwitcher({ currentSlug }: Props) {
  const [venues, setVenues] = useState<VenueListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAllVenues()
      .then(setVenues)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const tenantId = e.target.value;
    if (!tenantId) return;
    setSwitching(true);
    setError(null);
    try {
      const res = await switchTenant(tenantId);
      // Reemplazar accessToken — refresh stays.
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('np_admin_token', res.accessToken);
        // Actualizar user JSON con nuevo tenantId/slug.
        const raw = window.localStorage.getItem('np_admin_user');
        if (raw) {
          const u = JSON.parse(raw) as { tenantId: string; venueSlug: string };
          u.tenantId = res.tenantId;
          u.venueSlug = res.venueSlug;
          window.localStorage.setItem('np_admin_user', JSON.stringify(u));
        }
      }
      // Reload — carga todos los paneles con el nuevo contexto.
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setSwitching(false);
    }
  }

  if (loading) return null;
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
        disabled={switching}
        style={selectStyle}
      >
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      {error ? <p style={errStyle}>{error}</p> : null}
    </div>
  );
}

const wrapperStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.15rem',
};

const labelStyle: CSSProperties = {
  fontSize: '0.65rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--np-text-dim)',
  fontWeight: 500,
};

const selectStyle: CSSProperties = {
  padding: '0.4rem 0.6rem',
  borderRadius: '0.4rem',
  border: '1px solid var(--np-border)',
  background: 'var(--np-bg-input, var(--np-surface))',
  color: 'var(--np-text)',
  fontSize: '0.85rem',
  fontWeight: 500,
  cursor: 'pointer',
};

const errStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  color: 'var(--np-danger)',
};
