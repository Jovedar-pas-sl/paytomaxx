'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@nightpay/ui';
import type { MoneyMapQuery } from '@nightpay/contracts';
import { fetchMoneyMap, fetchNights, type CobrosFilters, type NightListItem } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { moneyMapCobrosFilter } from '@/lib/money-map-cobros';
import { createMoneyMapLoader, moneyMapFreshness, moneyMapStamp, type MoneyMapLoadState } from '@/lib/money-map-loading';
import { guardarEnUrl, lineaPeriodo, mapaQuery, periodoDeLaUrl, PERIODOS_NOCHE, resolverPeriodo, type Periodo } from '@/lib/periodos';
import type { TabKey } from '@/lib/roles';
import { usePolling } from '@/lib/use-polling';
import { useVenue } from '@/lib/venue-context';
import { Notice } from '../Notice';
import { SelectorNoches } from '../SelectorNoches';
import { MoneyMapSkeleton, MoneyMapView } from './MoneyMapView';

const POLL_MS = 30_000;
const MAX_POLL_MS = 240_000;
/** Los periodos del calendario: no necesitan las noches. */
const CALENDARIO: ReadonlyArray<Periodo['clave']> = ['mes', 'mes-pasado', 'trimestre-pasado', 'ano', 'fechas'];

/**
 * Hoy → Mapa del dinero (maqueta 8 · A): esta noche, en directo, otra noche,
 * varias o unas fechas (SelectorNoches). Cómo entra el dinero, a qué sección
 * va, cómo se reparte, dónde está y qué sale; la hora es la de los datos
 * (generatedAt). Al cerrar la noche se congela en su Z (Informes → Noches).
 * Tocar una cifra abre sus cobros.
 */
export function MoneyMapPanel({ onNavigate, onOpenCobros }: { onNavigate?: (key: TabKey) => void; onOpenCobros?: (filter: CobrosFilters) => void }) {
  const venue = useVenue();
  const [{ map, loading, error }, setState] = useState<MoneyMapLoadState>({ map: null, shown: null, requested: {}, loading: false, error: null });
  const [periodo, setPeriodo] = useState<Periodo>(() => periodoDeLaUrl({ clave: 'esta-noche' }));
  const [nights, setNights] = useState<NightListItem[] | null>(null);
  const [nightsError, setNightsError] = useState(false);
  const loader = useRef<ReturnType<typeof createMoneyMapLoader> | null>(null);
  useEffect(() => {
    const current = createMoneyMapLoader(fetchMoneyMap, setState);
    loader.current = current;
    setState(current.snapshot());
    return () => { current.dispose(); if (loader.current === current) loader.current = null; };
  }, [venue.slug]);

  const loadNights = useCallback(() => {
    setNightsError(false);
    fetchNights().then(
      (list) => { setNights(list); setNightsError(false); },
      () => setNightsError(true),
    );
  }, []);
  useEffect(loadNights, [loadNights, venue.slug]);

  // Lo que se pide: Esta noche, {} ya (sin esperar a las noches); el calendario, sus días; lo demás, con las noches.
  // Si las noches fallan, el mapa va sin parámetro (esta noche): nunca todas las fechas bajo el nombre de un periodo.
  const { query, linea } = useMemo((): { query: MoneyMapQuery | null; linea: string | null } => {
    const now = new Date();
    if (periodo.clave === 'esta-noche') return { query: {}, linea: nights ? lineaPeriodo(resolverPeriodo(periodo, nights, now), now) : null };
    if (CALENDARIO.includes(periodo.clave)) {
      const r = resolverPeriodo(periodo, [], now);
      return { query: mapaQuery(periodo, r), linea: lineaPeriodo(r, now) };
    }
    if (nightsError) return { query: {}, linea: null };
    if (!nights) return { query: null, linea: null };
    const r = resolverPeriodo(periodo, nights, now);
    return { query: mapaQuery(periodo, r), linea: lineaPeriodo(r, now) };
  }, [periodo, nights, nightsError]);

  const reload = usePolling(
    async (signal) => {
      if (!query) return true;
      // Esta noche: las noches, al día (una que se abre o se cierra cambia la línea).
      if (periodo.clave === 'esta-noche') fetchNights().then(setNights, () => undefined);
      return (await loader.current?.load(query, signal)) ?? false;
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS },
    [query?.night, query?.from, query?.to, query?.fromAt, query?.toAt, query === null, venue.slug],
  );

  function changePeriodo(next: Periodo): void {
    guardarEnUrl(next);
    if (JSON.stringify(next) === JSON.stringify(periodo)) reload();
    else setPeriodo(next);
  }

  const stamp = map ? moneyMapStamp(map) : null;
  const fresh = map ? moneyMapFreshness(map, venue.timezone) : null;
  // Sin noches en el periodo: no se pide el mapa.
  const vacio = query === null && nights !== null;
  const what = linea ?? 'esta noche';

  return (
    <section className="np-mm" aria-labelledby="np-mm-title">
      <header className="np-mm-head">
        <span className="np-mm-logo" aria-hidden="true" />
        <div className="np-mm-title">
          <h2 id="np-mm-title">{map?.scope.kind === 'period' ? 'El dinero de estas fechas' : 'El dinero de esta noche'}</h2>
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

      <div data-tour="mapa-fechas">
        <SelectorNoches
          value={periodo}
          onChange={changePeriodo}
          opciones={PERIODOS_NOCHE}
          nights={nights}
          linea={linea}
          nightsError={nightsError && !CALENDARIO.includes(periodo.clave)}
          onRetry={loadNights}
        />
      </div>
      {map && stamp && fresh ? (
        <p className="np-mm-note np-mm-fresh">
          {fresh.line} <time dateTime={stamp.generatedAt} className="np-sr-only">{formatDateTime(stamp.generatedAt, venue.timezone)}</time>
        </p>
      ) : null}
      {loading ? <p className="np-mm-note" role="status">Cargando: {what}…{map ? ' Se conserva el contexto de los datos mostrados.' : ''}</p> : null}

      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudo cargar el mapa ({what}): {error}
          {map ? ' · se siguen enseñando los últimos datos.' : ''}
        </Notice>
      ) : null}

      {vacio ? null : map ? (
        <MoneyMapView
          map={map}
          onOpen={onOpenCobros ? (target) => onOpenCobros(moneyMapCobrosFilter(map, target)) : undefined}
          onAction={onNavigate ? (action) => onNavigate(action === 'close-cash' ? 'nights' : 'treasury') : undefined}
        />
      ) : error ? null : <MoneyMapSkeleton />}

      {map && !vacio ? (
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
