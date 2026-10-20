'use client';

import { useEffect, useState } from 'react';
import type { MoneyMap } from '@nightpay/contracts';
import { ApiError } from '@/lib/api-errors';
import { fetchMoneyMap } from '@/lib/api';
import { moneyMapView } from '@/lib/money-map-view';
import { useSections } from '@/lib/use-sections';
import { Stripe } from '../fichas/FichaSheet';
import { MoneyMapView } from './MoneyMapView';

/**
 * El mapa del dinero de una noche, en su Z (Informes → Noches): el que se
 * congeló al cerrarla. Los Z de antes del mapa lo calculan con su ventana y
 * su corte. Sin permiso de informes (encargado), no sale.
 */
export function NightMoneyMap({ nightId }: { nightId: string }) {
  const { sections } = useSections();
  const [map, setMap] = useState<MoneyMap | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'hidden' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchMoneyMap({ night: nightId })
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
    };
  }, [nightId]);

  if (state === 'hidden') return null;
  const live = map?.scope.kind === 'night' && map.scope.open;
  return (
    <section className="np-mm-inz" aria-label="Mapa del dinero de la noche">
      <div className="np-mm-inz-head">
        <h3 className="np-mm-kick">Mapa del dinero</h3>
        {map ? (
          <span className="np-mm-chip" data-kind={live ? 'live' : 'frozen'}>
            {live ? 'En directo' : map.frozen ? 'Congelado en el Z' : 'Calculado con el Z'}
          </span>
        ) : null}
      </div>
      {map ? <Stripe segments={moneyMapView(map, sections).stripe} /> : null}
      {state === 'loading' ? <p className="np-mm-note">Cargando…</p> : null}
      {state === 'error' ? <p className="np-mm-note">No se pudo cargar el mapa del dinero de esta noche.</p> : null}
      {map ? <MoneyMapView map={map} /> : null}
    </section>
  );
}
