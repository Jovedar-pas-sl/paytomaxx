'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ackIncident, fetchIncidents, type Incident } from './api';
import { dayInZone } from './dates';
import { keepIfSame } from './diff';
import {
  incidentHeading,
  incidentKey,
  recordResolved,
  resolvedToday,
  vanished,
  type ResolvedIncident,
  type ResolvedLog,
} from './incident-inbox';
import { UNDO_RESOLVE_MS, createDelayedActions, type DelayedActions, type PendingResolve } from './undo-resolve';
import { usePolling } from './use-polling';

/** Suave: es para el globo de la barra y la franja; la pestaña refresca al abrirse. */
const POLL_MS = 30_000;
const MAX_POLL_MS = 5 * 60_000;

export interface IncidentsFeed {
  /** Abiertas; null = aún no han llegado. */
  open: Incident[] | null;
  telegram: boolean;
  error: string | null;
  /** Resueltas hoy (día del local) vistas desde este dispositivo, lo último primero. */
  resolved: ResolvedIncident[];
  refresh: () => void;
  /**
   * Marcar como revisada (solo el dueño). Se manda pasados 10 s (B11): hasta
   * entonces sale en `pending` y se puede deshacer. Si el API falla, vuelve a
   * la bandeja con su error en `failed`.
   */
  resolve: (incident: Incident, note?: string) => void;
  /** Las marcadas que aún se pueden deshacer. */
  pending: readonly PendingResolve[];
  /** «Deshacer»: la marcada vuelve a la bandeja sin mandarse. */
  undo: (key: string) => void;
  /** Error del último intento de marcarla, por aviso. */
  failed: Readonly<Record<string, string>>;
}

const EMPTY_FEED: IncidentsFeed = {
  open: null,
  telegram: false,
  error: null,
  resolved: [],
  refresh: () => undefined,
  resolve: () => undefined,
  pending: [],
  undo: () => undefined,
  failed: {},
};

export const IncidentsContext = createContext<IncidentsFeed>(EMPTY_FEED);

export function useIncidents(): IncidentsFeed {
  return useContext(IncidentsContext);
}

/**
 * Incidencias abiertas del local, pedidas una vez para todo el panel (solo con
 * el navegador a la vista). Lo que desaparece de la lista o se marca aquí pasa
 * a «Resueltas hoy», guardado en este navegador.
 */
export function useIncidentsFeed(tenantId: string, timezone: string): IncidentsFeed {
  const [data, setData] = useState<{ items: Incident[]; telegram: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<ResolvedLog | null>(null);
  const lastItems = useRef<Incident[] | null>(null);
  const storageKey = `np-incidents-resolved:${tenantId}`;

  useEffect(() => {
    setLog(readLog(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (log) writeLog(storageKey, log);
  }, [log, storageKey]);

  const record = useCallback(
    (fresh: ResolvedIncident[]) => {
      const day = dayInZone(new Date(), timezone);
      setLog((prev) => {
        const known = new Set(resolvedToday(prev, day).map((r) => r.key));
        // Lo que ya estaba apuntado (p. ej. marcado aquí) no se pisa al desaparecer.
        const add = fresh.filter((r) => r.how === 'ack' || !known.has(r.key));
        return add.length > 0 ? recordResolved(prev, day, add) : prev;
      });
    },
    [timezone],
  );

  const refresh = usePolling(
    async (signal) => {
      try {
        const next = await fetchIncidents();
        if (signal.aborted) return true;
        const previous = lastItems.current;
        lastItems.current = next.items;
        if (previous) {
          const gone = vanished(previous, next.items);
          if (gone.length > 0) record(gone.map((i) => toResolved(i, 'gone')));
        }
        setData((prev) => keepIfSame(prev, next));
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS },
    [tenantId],
  );

  // «Resolver» con 10 s para deshacer (B11).
  const [pending, setPending] = useState<PendingResolve[]>([]);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const delayed = useRef<DelayedActions | null>(null);
  delayed.current ??= createDelayedActions();
  // Al cerrar la pestaña, lo marcado se manda ya (con keepalive, para que llegue).
  const leaving = useRef(false);

  const commit = useCallback(
    async (incident: Incident, note: string | undefined) => {
      const key = incidentKey(incident);
      try {
        await ackIncident(
          { kind: incident.kind, refId: incident.refId, ...(note ? { note } : {}) },
          { keepalive: leaving.current },
        );
        record([{ ...toResolved(incident, 'ack'), ...(note ? { note } : {}) }]);
        lastItems.current = lastItems.current?.filter((i) => incidentKey(i) !== key) ?? null;
        setData((prev) => (prev ? { ...prev, items: prev.items.filter((i) => incidentKey(i) !== key) } : prev));
        refresh();
      } catch (err) {
        setFailed((prev) => ({ ...prev, [key]: (err as Error).message }));
      } finally {
        setPending((prev) => prev.filter((p) => p.key !== key));
      }
    },
    [record, refresh],
  );
  // El temporizador llama a la versión de ahora (no a la de cuando se marcó).
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const resolve = useCallback((incident: Incident, note?: string) => {
    const key = incidentKey(incident);
    setFailed((prev) => (key in prev ? withoutKey(prev, key) : prev));
    setPending((prev) => [...prev.filter((p) => p.key !== key), { key, until: Date.now() + UNDO_RESOLVE_MS }]);
    delayed.current?.schedule(key, () => void commitRef.current(incident, note), UNDO_RESOLVE_MS);
  }, []);

  const undo = useCallback((key: string) => {
    if (delayed.current?.cancel(key)) setPending((prev) => prev.filter((p) => p.key !== key));
  }, []);

  // Cerrar la pestaña o salir del panel: lo marcado no se pierde.
  useEffect(() => {
    const queue = delayed.current;
    const onLeave = () => {
      leaving.current = true;
      queue?.flush();
    };
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      queue?.flush();
    };
  }, []);

  const resolved = useMemo(() => resolvedToday(log, dayInZone(new Date(), timezone)), [log, timezone]);

  const open = useMemo(() => {
    if (!data) return null;
    // Una petición que salió antes de marcarla aún la trae: no vuelve a aparecer.
    const acked = new Set(resolved.filter((r) => r.how === 'ack').map((r) => r.key));
    return acked.size > 0 ? data.items.filter((i) => !acked.has(incidentKey(i))) : data.items;
  }, [data, resolved]);

  return useMemo(
    () => ({ open, telegram: data?.telegram ?? false, error, resolved, refresh, resolve, pending, undo, failed }),
    [open, data?.telegram, error, resolved, refresh, resolve, pending, undo, failed],
  );
}

function withoutKey(map: Readonly<Record<string, string>>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
}

function toResolved(i: Incident, how: ResolvedIncident['how']): ResolvedIncident {
  return { key: incidentKey(i), kind: i.kind, title: incidentHeading(i), resolvedAt: new Date().toISOString(), how };
}

/** Lo guardado en el navegador; cualquier cosa rara se ignora (y se empieza de cero). */
function readLog(key: string): ResolvedLog | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ResolvedLog>;
    if (typeof parsed.day !== 'string' || !Array.isArray(parsed.items)) return null;
    const items = parsed.items.filter(
      (r): r is ResolvedIncident =>
        typeof r?.key === 'string' &&
        typeof r.kind === 'string' &&
        typeof r.title === 'string' &&
        typeof r.resolvedAt === 'string' &&
        (r.how === 'ack' || r.how === 'gone'),
    );
    return { day: parsed.day, items };
  } catch {
    return null;
  }
}

function writeLog(key: string, log: ResolvedLog): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(log));
  } catch {
    // Sin almacenamiento (modo privado): «Resueltas hoy» dura lo que la pestaña.
  }
}
