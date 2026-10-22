'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input } from '@nightpay/ui';
import type { MoneyMapQuery } from '@nightpay/contracts';
import { fetchMoneyMap } from '@/lib/api';
import { formatDateTime, madridToday } from '@/lib/dates';
import { moneyMapView } from '@/lib/money-map-view';
import { createMoneyMapLoader, moneyMapPeriod, moneyMapStamp, type MoneyMapLoadState } from '@/lib/money-map-loading';
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
  const [{ map, shown, requested, loading, error }, setState] = useState<MoneyMapLoadState>({ map: null, shown: null, requested: {}, loading: false, error: null });
  const [query, setQuery] = useState<MoneyMapQuery>({});
  const [from, setFrom] = useState(madridToday);
  const [to, setTo] = useState(madridToday);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const loader = useRef<ReturnType<typeof createMoneyMapLoader> | null>(null);
  useEffect(() => {
    const current = createMoneyMapLoader(fetchMoneyMap, setState);
    loader.current = current;
    setState(current.snapshot());
    return () => { current.dispose(); if (loader.current === current) loader.current = null; };
  }, [venue.slug]);

  const reload = usePolling(
    async (signal) => {
      return (await loader.current?.load(query, signal)) ?? false;
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS },
    [query.from, query.to, venue.slug],
  );

  function applyPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const period = moneyMapPeriod(from, to);
      setRangeError(null);
      if (query.from === period.from && query.to === period.to) reload();
      else setQuery(period);
    } catch (err) { setRangeError((err as Error).message); }
  }

  const scope = map?.scope.kind === 'night' ? map.scope : null;
  const since = map ? formatDateTime(map.from, venue.timezone, 'time') : null;
  const nightText = map ? (map.scope.kind === 'period' ? `Periodo mostrado: ${shown?.from} — ${shown?.to} (ambos días incluidos, hora de Madrid)` : scope?.open ? `Esta noche, desde las ${since}` : `Sin noche abierta: desde el último cierre (${since})`) : null;
  const stamp = map ? moneyMapStamp(map) : null;
  const stripe = map ? moneyMapView(map, sections).stripe : [];

  return (
    <section className="np-mm" aria-labelledby="np-mm-title">
      <header className="np-mm-head">
        <span className="np-mm-logo" aria-hidden="true" />
        <div className="np-mm-title">
          <h2 id="np-mm-title">Mapa del dinero</h2>
          <span>{venue.name ?? venue.slug}</span>
        </div>
        <span className="np-mm-chip" data-kind={error || loading ? 'hold' : stamp?.kind ?? 'hold'}>
          {error ? 'Sin actualizar' : loading ? 'Actualizando…' : stamp?.label ?? 'Sin datos'}
        </span>
      </header>
      <Stripe segments={stripe} />

      <form className="np-mm-period" aria-label="Periodo del mapa del dinero" onSubmit={applyPeriod}>
        <Input label="Desde" type="date" value={from} onChange={(event) => setFrom(event.target.value)} required />
        <Input label="Hasta" type="date" value={to} onChange={(event) => setTo(event.target.value)} min={from || undefined} required />
        <Button type="submit" variant="ghost">Ver periodo</Button>
        <Button type="button" variant="ghost" onClick={() => { setRangeError(null); if (!query.from) reload(); else setQuery({}); }}>Esta noche</Button>
        <p className="np-mm-note">Fechas de Madrid, ambos días incluidos.</p>
      </form>
      {rangeError ? <Notice tone="danger">{rangeError}</Notice> : null}
      {map && stamp ? <p className="np-mm-note">{nightText}. Datos generados el <time dateTime={stamp.generatedAt}>{formatDateTime(stamp.generatedAt, venue.timezone)}</time>.</p> : null}
      {loading ? <p className="np-mm-note" role="status">Cargando {requested.from ? `el periodo ${requested.from} — ${requested.to}` : 'esta noche'}…{map ? ' Se conserva el contexto de los datos mostrados.' : ''}</p> : null}

      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudo cargar {requested.from ? `el periodo ${requested.from} — ${requested.to}` : 'el mapa de esta noche'}: {error}
          {map ? ' · se siguen enseñando los últimos datos.' : ''}
        </Notice>
      ) : null}

      {map ? <MoneyMapView map={map} wide /> : error ? null : <p className="np-mm-note">Cargando…</p>}

      {map ? (
        <p className="np-mm-foot">
          {map.scope.kind === 'night' ? 'Al cerrar la noche, su mapa se congela en el Z. ' : ''}Sin IVA: eso lo lleva la gestoría.
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
