import { useEffect, useSyncExternalStore } from 'react';

/**
 * Señales de conexión que dan las pantallas de cobro (el cobro abierto, el
 * del saldo…) para el aviso de arriba del Dashboard. Cada pantalla informa
 * con su nombre y lo retira al cerrarse; el aviso junta todas.
 */
export interface HealthReport {
  /** Esta pantalla no consigue hablar con el API (5xx, sin respuesta, socket y sondeo caídos). */
  readonly serverDown?: boolean;
  /** Su cobro espera al banco (AUTHORIZING) desde esta hora (ms). */
  readonly bankWaitingSinceMs?: number | null;
  /** Su cobro quedó sin confirmar por el banco (ORPHAN). */
  readonly orphan?: boolean;
}

export interface HealthSnapshot {
  readonly serverDown: boolean;
  /** La espera más larga de todas; null si ningún cobro espera al banco. */
  readonly bankWaitingSinceMs: number | null;
  readonly orphan: boolean;
}

const HEALTHY: HealthSnapshot = { serverDown: false, bankWaitingSinceMs: null, orphan: false };

/** Junta lo que dicen las pantallas: basta una con problema para avisar. */
export function mergeHealth(reports: Iterable<HealthReport>): HealthSnapshot {
  let serverDown = false;
  let orphan = false;
  let since: number | null = null;
  for (const r of reports) {
    serverDown ||= r.serverDown === true;
    orphan ||= r.orphan === true;
    const s = r.bankWaitingSinceMs ?? null;
    if (s !== null && (since === null || s < since)) since = s;
  }
  if (!serverDown && !orphan && since === null) return HEALTHY;
  return { serverDown, bankWaitingSinceMs: since, orphan };
}

export interface HealthStore {
  /** null: la pantalla se fue (o ya no tiene nada que decir). */
  report(source: string, report: HealthReport | null): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): HealthSnapshot;
}

export function createHealthStore(): HealthStore {
  let reports: ReadonlyMap<string, HealthReport> = new Map();
  let snapshot = HEALTHY;
  const listeners = new Set<() => void>();

  return {
    report(source, report) {
      const next = new Map(reports);
      if (report) next.set(source, report);
      else next.delete(source);
      reports = next;
      const merged = mergeHealth(next.values());
      if (sameSnapshot(merged, snapshot)) return;
      snapshot = merged;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

function sameSnapshot(a: HealthSnapshot, b: HealthSnapshot): boolean {
  return a.serverDown === b.serverDown && a.orphan === b.orphan && a.bankWaitingSinceMs === b.bankWaitingSinceMs;
}

/** El de la app (uno por pestaña del navegador). */
export const connectionHealth = createHealthStore();

export function useConnectionHealth(store: HealthStore = connectionHealth): HealthSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => HEALTHY);
}

/** Informa mientras la pantalla está montada; al desmontarse, lo retira. */
export function useHealthReport(source: string, report: HealthReport, store: HealthStore = connectionHealth): void {
  const { serverDown = false, bankWaitingSinceMs = null, orphan = false } = report;
  useEffect(() => {
    store.report(source, { serverDown, bankWaitingSinceMs, orphan });
  }, [store, source, serverDown, bankWaitingSinceMs, orphan]);
  useEffect(() => () => store.report(source, null), [store, source]);
}
