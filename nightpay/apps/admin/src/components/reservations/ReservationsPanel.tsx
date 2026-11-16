'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import type { ReservationPackageView } from '@nightpay/contracts';
import { fetchPackages } from '@/lib/endpoints/reservations';
import { NightList } from './NightList';
import { PackagesEditor } from './PackagesEditor';
import { PromotersCard } from './PromotersCard';
import { ReservationsLinkCard } from './ReservationsLinkCard';

type View = 'night' | 'packages' | 'promoters' | 'link';

const VIEWS: ReadonlyArray<{ key: View; label: string }> = [
  { key: 'night', label: 'Reservas' },
  { key: 'packages', label: 'Paquetes' },
  { key: 'promoters', label: 'RRPP' },
  { key: 'link', label: 'Enlace y señales' },
];

/**
 * Clientes → Reservados (dueño y encargado): las reservas de la noche (mesa,
 * cambiar la fecha, anular, «No vino»), los paquetes, los RRPP (su % y su
 * enlace) y el enlace web con «Señales de reservas». La puerta y la barra van
 * en la app del personal.
 */
export function ReservationsPanel({ isOwner }: { isOwner: boolean }) {
  const [view, setView] = useState<View>('night');
  const [packages, setPackages] = useState<ReservationPackageView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchPackages().then(setPackages, (err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  return (
    <div style={stack}>
      <div style={row} role="tablist" aria-label="Reservados" data-tour="reservados-vistas">
        {VIEWS.map((v) => (
          <Button key={v.key} role="tab" aria-selected={view === v.key} variant={view === v.key ? 'primary' : 'ghost'} size="sm" onClick={() => setView(v.key)}>
            {v.label}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="np-set-error">
          {error}
        </p>
      ) : null}
      {view === 'night' ? <NightList packages={packages} /> : null}
      {view === 'packages' ? <PackagesEditor packages={packages} onChanged={load} /> : null}
      {view === 'promoters' ? <PromotersCard isOwner={isOwner} /> : null}
      {view === 'link' ? <ReservationsLinkCard isOwner={isOwner} /> : null}
    </div>
  );
}

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '48rem' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' };
