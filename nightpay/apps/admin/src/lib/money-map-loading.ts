import type { MoneyMap, MoneyMapQuery } from '@nightpay/contracts';
import { formatDateTime } from './dates';
import { moneyMapIsCurrent } from './money-map-view';

export interface MoneyMapLoadState {
  map: MoneyMap | null;
  shown: MoneyMapQuery | null;
  requested: MoneyMapQuery;
  loading: boolean;
  error: string | null;
}

/** Solo la última solicitud puede publicar; el contexto mostrado pertenece siempre a sus datos. */
export function createMoneyMapLoader(
  fetchMap: (query: MoneyMapQuery, signal?: AbortSignal) => Promise<MoneyMap>,
  publish: (state: MoneyMapLoadState) => void,
) {
  let state: MoneyMapLoadState = { map: null, shown: null, requested: {}, loading: false, error: null };
  let active: AbortController | null = null;
  let version = 0;
  let disposed = false;
  return {
    snapshot: () => state,
    async load(query: MoneyMapQuery, signal?: AbortSignal): Promise<boolean> {
      if (disposed || signal?.aborted) return false;
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const current = ++version;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      state = { ...state, requested: { ...query }, loading: true, error: null };
      publish(state);
      try {
        const map = await fetchMap(query, controller.signal);
        if (disposed || controller.signal.aborted || current !== version) return false;
        state = { map, shown: { ...query }, requested: { ...query }, loading: false, error: null };
        publish(state);
        return true;
      } catch (err) {
        if (!disposed && !controller.signal.aborted && current === version) {
          state = { ...state, loading: false, error: (err as Error).message };
          publish(state);
        }
        return false;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (active === controller) active = null;
      }
    },
    dispose: () => { disposed = true; ++version; active?.abort(); },
  };
}

/** Días de Madrid, ambos incluidos; el API recibe las fechas sin conversiones del navegador. */
export function moneyMapPeriod(from: string, to: string): MoneyMapQuery {
  const realDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  if (!realDay(from) || !realDay(to) || to < from) throw new Error('Elige un periodo válido: indica las dos fechas y pon la final después de la inicial.');
  return { from, to };
}

export function moneyMapStamp(map: MoneyMap): { kind: 'live' | 'frozen' | 'hold'; label: string; generatedAt: string } {
  return {
    kind: moneyMapIsCurrent(map) ? 'live' : map.frozen || map.scope.kind === 'night' ? 'frozen' : 'hold',
    label: map.frozen ? 'Congelado en el Z' : moneyMapIsCurrent(map) ? 'En directo' : map.scope.kind === 'night' ? 'Al corte del Z' : 'Periodo',
    generatedAt: map.generatedAt,
  };
}

/**
 * La hora de los datos (generatedAt, no el reloj del móvil) y su estado, en
 * palabras: el chip de arriba y la línea de debajo.
 *  - En directo: «En directo · 03:40».
 *  - Congelado en el Z: no cambia; con la fecha del corte.
 *  - Un Z de antes del mapa: calculado con su corte.
 *  - Unas fechas: «Periodo · 03:40».
 */
export function moneyMapFreshness(map: MoneyMap, timeZone: string): { chip: string; short: string; line: string } {
  const at = formatDateTime(map.generatedAt, timeZone, 'time');
  const when = formatDateTime(map.generatedAt, timeZone, 'compact');
  const cut = formatDateTime(map.to, timeZone, 'compact');
  const since = formatDateTime(map.from, timeZone, 'compact');
  if (moneyMapIsCurrent(map)) {
    const scope = map.scope.kind === 'night' && map.scope.open ? 'Noche abierta' : 'Sin noche abierta: desde el último cierre';
    return { chip: `En directo · ${at}`, short: at, line: `${scope}, desde el ${since}. Datos de las ${at}; se ponen al día solos.` };
  }
  if (map.frozen) {
    return { chip: 'Congelado en el Z', short: 'Congelado', line: `Z del ${since} al corte del ${cut}. Congelado al cerrar la noche: ya no cambia.` };
  }
  if (map.scope.kind === 'night') {
    return { chip: 'Al corte del Z', short: 'Al corte del Z', line: `Z del ${since} al corte del ${cut}, calculado con ese corte (datos del ${when}).` };
  }
  return { chip: `Periodo · ${at}`, short: at, line: `Datos de las ${at} (${when}).` };
}
