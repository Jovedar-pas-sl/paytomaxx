'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input } from '@nightpay/ui';
import type { MoneyMapQuery } from '@nightpay/contracts';
import { fetchMoneyMap, type CobrosFilters } from '@/lib/api';
import { formatDateTime, madridToday } from '@/lib/dates';
import { moneyMapView } from '@/lib/money-map-view';
import { moneyMapCobrosFilter } from '@/lib/money-map-cobros';
import { createMoneyMapLoader, moneyMapFreshness, moneyMapPeriod, moneyMapStamp, type MoneyMapLoadState } from '@/lib/money-map-loading';
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
 * Hoy → Mapa del dinero (maqueta 8 · A): esta noche, en directo, o unas
 * fechas. Cómo entra el dinero, a qué sección va, cómo se reparte, dónde está
 * y qué sale; la hora es la de los datos (generatedAt). Al cerrar la noche se
 * congela en su Z (Informes → Noches). Tocar una cifra abre sus cobros.
 */
export function MoneyMapPanel({ onNavigate, onOpenCobros }: { onNavigate?: (key: TabKey) => void; onOpenCobros?: (filter: CobrosFilters) => void }) {
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

  const stamp = map ? moneyMapStamp(map) : null;
  const fresh = map ? moneyMapFreshness(map, venue.timezone) : null;
  const periodText = map?.scope.kind === 'period' ? `Del ${dayLabel(shown?.from)} al ${dayLabel(shown?.to)}, ambos incluidos (hora de Madrid). ` : '';
  const stripe = map ? moneyMapView(map, sections).stripe : [];

  return (
    <section className="np-mm" aria-labelledby="np-mm-title">
      <header className="np-mm-head">
        <span className="np-mm-logo" aria-hidden="true" />
        <div className="np-mm-title">
          <h2 id="np-mm-title">Mapa del dinero</h2>
          <span>{venue.name ?? venue.slug}</span>
        </div>
        {/* La hora de los datos (generatedAt), como la maqueta: el estado entero, para el lector de pantalla. */}
        <span className="np-mm-chip" data-kind={error ? 'hold' : stamp?.kind ?? 'hold'} title={fresh?.chip}>
          {error ? 'Sin actualizar' : fresh ? (
            <>
              <span aria-hidden="true">{fresh.short}</span>
              <span className="np-sr-only">{fresh.chip}</span>
            </>
          ) : loading ? 'Cargando…' : 'Sin datos'}
        </span>
      </header>
      <Stripe segments={stripe} />

      <details className="np-mm-period-box">
        <summary>
          <span>Fechas: <b>{query.from ? `${dayLabel(query.from)} – ${dayLabel(query.to)}` : 'esta noche'}</b></span>
          <span className="np-mm-period-change">Cambiar</span>
        </summary>
        <form className="np-mm-period" aria-label="Periodo del mapa del dinero" onSubmit={applyPeriod}>
          <Input label="Desde" type="date" value={from} onChange={(event) => setFrom(event.target.value)} required />
          <Input label="Hasta" type="date" value={to} onChange={(event) => setTo(event.target.value)} min={from || undefined} required />
          <Button type="submit" variant="ghost">Ver periodo</Button>
          <Button type="button" variant="ghost" onClick={() => { setRangeError(null); if (!query.from) reload(); else setQuery({}); }}>Esta noche</Button>
          <p className="np-mm-note">Fechas de Madrid, ambos días incluidos.</p>
        </form>
      </details>
      {rangeError ? <Notice tone="danger">{rangeError}</Notice> : null}
      {map && stamp && fresh ? (
        <p className="np-mm-note np-mm-fresh">
          {periodText}{fresh.line} <time dateTime={stamp.generatedAt} className="np-sr-only">{formatDateTime(stamp.generatedAt, venue.timezone)}</time>
        </p>
      ) : null}
      {loading ? <p className="np-mm-note" role="status">Cargando {requested.from ? `el periodo ${requested.from} — ${requested.to}` : 'esta noche'}…{map ? ' Se conserva el contexto de los datos mostrados.' : ''}</p> : null}

      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudo cargar {requested.from ? `el periodo ${requested.from} — ${requested.to}` : 'el mapa de esta noche'}: {error}
          {map ? ' · se siguen enseñando los últimos datos.' : ''}
        </Notice>
      ) : null}

      {map ? (
        <MoneyMapView map={map} wide onOpen={onOpenCobros ? (target) => onOpenCobros(moneyMapCobrosFilter(map, target)) : undefined} />
      ) : error ? null : <p className="np-mm-note">Cargando…</p>}

      {map ? (
        <p className="np-mm-foot">
          {map.scope.kind === 'night' ? 'Al cerrar la noche, su mapa se congela en el Z. ' : ''}Sin IVA: eso lo lleva la gestoría.
          {onNavigate ? (
            <>
              {' '}
              <Button variant="ghost" size="sm" onClick={() => onNavigate('nights')}>
                Noches cerradas
              </Button>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

/** «2026-10-21» → «21/10/2026». */
function dayLabel(day: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (day ?? '');
}
