'use client';

import { useEffect, useState } from 'react';
import type { MoneyMap } from '@nightpay/contracts';
import { ApiError } from '@/lib/api-errors';
import { fetchMoneyMap, type CobrosFilters } from '@/lib/api';
import { moneyMapView } from '@/lib/money-map-view';
import { moneyMapCobrosFilter } from '@/lib/money-map-cobros';
import { moneyMapFreshness, moneyMapStamp } from '@/lib/money-map-loading';
import { useVenueTimezone } from '@/lib/venue-context';
import { useSections } from '@/lib/use-sections';
import { Stripe } from '../fichas/FichaSheet';
import { MoneyMapView } from './MoneyMapView';

/**
 * El mapa del dinero de una noche, en su Z (Informes → Noches): el que se
 * congeló al cerrarla. Los Z de antes del mapa lo calculan con su ventana y
 * su corte. Sin permiso de informes (encargado), no sale.
 */
export function NightMoneyMap({ nightId, onOpenCobros }: { nightId: string; onOpenCobros?: (filter: CobrosFilters) => void }) {
  const { sections } = useSections();
  const timezone = useVenueTimezone();
  const [map, setMap] = useState<MoneyMap | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'hidden' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setMap(null);
    setState('loading');
    fetchMoneyMap({ night: nightId }, controller.signal)
      .then((m) => {
        if (cancelled) return;
        setMap(m);
        setState('ok');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState(err instanceof ApiError && err.status === 403 ? 'hidden' : 'error');
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [nightId]);

  if (state === 'hidden') return null;
  const stamp = map ? moneyMapStamp(map) : null;
  const fresh = map ? moneyMapFreshness(map, timezone) : null;
  return (
    <section className="np-mm-inz" aria-label="Mapa del dinero de la noche">
      <div className="np-mm-inz-head">
        <h3 className="np-mm-kick">Mapa del dinero</h3>
        {map ? (
          <span className="np-mm-chip" data-kind={stamp!.kind}>
            {fresh!.chip}
          </span>
        ) : null}
      </div>
      {map ? <Stripe segments={moneyMapView(map, sections).stripe} /> : null}
      {map ? <p className="np-mm-note np-mm-fresh">{fresh!.line}</p> : null}
      {state === 'loading' ? <p className="np-mm-note">Cargando…</p> : null}
      {state === 'error' ? <p className="np-mm-note">No se pudo cargar el mapa del dinero de esta noche.</p> : null}
      {map ? <MoneyMapView map={map} onOpen={onOpenCobros ? (target) => onOpenCobros(moneyMapCobrosFilter(map, target)) : undefined} /> : null}
    </section>
  );
}
