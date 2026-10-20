'use client';

import { useState } from 'react';
import { Button, useNow } from '@nightpay/ui';
import type { MoneyMap } from '@nightpay/contracts';
import { fetchMoneyMap } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { moneyMapView } from '@/lib/money-map-view';
import type { TabKey } from '@/lib/roles';
import { usePolling } from '@/lib/use-polling';
import { useSections } from '@/lib/use-sections';
import { useVenue } from '@/lib/venue-context';
import { Stripe } from '../fichas/FichaSheet';
import { Notice } from '../Notice';
import { MoneyMapView } from './MoneyMapView';

const POLL_MS = 30_000;
const MAX_POLL_MS = 240_000;

/**
 * Hoy → Mapa del dinero (maqueta 8 · A): esta noche, en directo. Cómo entra
 * el dinero, a qué sección va, dónde está y qué sale. Al cerrar la noche se
 * congela en su Z (Informes → Noches).
 */
export function MoneyMapPanel({ onNavigate }: { onNavigate?: (key: TabKey) => void }) {
  const venue = useVenue();
  const { sections } = useSections();
  const [map, setMap] = useState<MoneyMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(true, 30_000);

  const reload = usePolling(
    async (signal) => {
      try {
        const fresh = await fetchMoneyMap();
        if (signal.aborted) return true;
        setMap(fresh);
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS },
    [],
  );

  const scope = map?.scope.kind === 'night' ? map.scope : null;
  const since = map ? formatDateTime(map.from, venue.timezone, 'time') : null;
  const subtitle = [venue.name ?? venue.slug, map ? (scope?.open ? `noche desde las ${since}` : `desde el último cierre (${since})`) : null]
    .filter(Boolean)
    .join(' · ');
  const stripe = map ? moneyMapView(map, sections).stripe : [];

  return (
    <section className="np-mm" aria-labelledby="np-mm-title">
      <header className="np-mm-head">
        <span className="np-mm-logo" aria-hidden="true" />
        <div className="np-mm-title">
          <h2 id="np-mm-title">Mapa del dinero</h2>
          <span>{subtitle}</span>
        </div>
        <span className="np-mm-chip" data-kind="live" title="En directo: se pone al día solo">
          <span className="np-sr-only">En directo, </span>
          {formatDateTime(new Date(now), venue.timezone, 'time')}
        </span>
      </header>
      <Stripe segments={stripe} />

      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudo cargar el mapa del dinero: {error}
          {map ? ' · se siguen enseñando los últimos datos.' : ''}
        </Notice>
      ) : null}

      {map ? <MoneyMapView map={map} wide /> : error ? null : <p className="np-mm-note">Cargando…</p>}

      {map ? (
        <p className="np-mm-foot">
          En directo; al cerrar la noche se congela en el Z. Sin IVA: eso lo lleva la gestoría.
          {onNavigate ? (
            <>
              {' '}
              <Button variant="ghost" onClick={() => onNavigate('nights')} style={{ height: '2.75rem', padding: '0 1rem', fontSize: '0.875rem' }}>
                Noches cerradas
              </Button>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
