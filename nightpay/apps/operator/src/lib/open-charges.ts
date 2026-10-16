import { useEffect, useSyncExternalStore } from 'react';
import type { TabKey } from './roles';

/**
 * Cobros en pantalla: el QR de Inicio, el del saldo, la ficha NFC. Si la
 * sesión caduca con uno abierto, la app no se desmonta (se pide entrar otra
 * vez encima) para no perder el QR, su cuenta atrás y su «PAGADO».
 * Cada pantalla de cobro se apunta mientras está y se borra al cerrarse.
 */
export type ChargeSpot = 'cobro' | 'saldo' | 'ficha';

export interface OpenCharges {
  /** Hay algún cobro en pantalla (esperando, o con su resultado aún a la vista). */
  readonly open: boolean;
  /** Alguno sigue esperando al cliente o al banco. */
  readonly pending: boolean;
  /** Dónde están, en el orden en que se abrieron. */
  readonly spots: readonly ChargeSpot[];
}

const NONE: OpenCharges = { open: false, pending: false, spots: [] };

/** spot → ¿sigue esperando? */
export function summarizeCharges(entries: ReadonlyMap<ChargeSpot, boolean>): OpenCharges {
  if (entries.size === 0) return NONE;
  return { open: true, pending: [...entries.values()].some(Boolean), spots: [...entries.keys()] };
}

export interface OpenChargeStore {
  /** null: esa pantalla ya no tiene cobro abierto. */
  set(spot: ChargeSpot, state: { pending: boolean } | null): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): OpenCharges;
}

export function createOpenChargeStore(): OpenChargeStore {
  let entries: ReadonlyMap<ChargeSpot, boolean> = new Map();
  let snapshot = NONE;
  const listeners = new Set<() => void>();
  return {
    set(spot, state) {
      if (state === null ? !entries.has(spot) : entries.get(spot) === state.pending) return;
      const next = new Map(entries);
      if (state) next.set(spot, state.pending);
      else next.delete(spot);
      entries = next;
      snapshot = summarizeCharges(next);
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

/** El de la app (uno por pestaña del navegador). */
export const openCharges = createOpenChargeStore();

export function useOpenCharges(store: OpenChargeStore = openCharges): OpenCharges {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => NONE);
}

/** Se apunta mientras `active`; al desmontarse, se borra. */
export function useOpenCharge(spot: ChargeSpot, active: boolean, pending: boolean, store: OpenChargeStore = openCharges): void {
  useEffect(() => {
    store.set(spot, active ? { pending } : null);
  }, [store, spot, active, pending]);
  useEffect(() => () => store.set(spot, null), [store, spot]);
}

/** En qué pestaña vive cada cobro (la ficha sale encima de todas). */
const SPOT_TAB: Partial<Record<ChargeSpot, TabKey>> = { cobro: 'home', saldo: 'wallet' };

/**
 * La sesión caducó: si la pestaña que se ve no tiene el cobro abierto, a cuál
 * ir para tenerlo delante. null: quedarse.
 */
export function tabForOpenCharge(spots: readonly ChargeSpot[], current: TabKey): TabKey | null {
  const tabs = spots.map((s) => SPOT_TAB[s]).filter((t): t is TabKey => t !== undefined);
  if (tabs.length === 0 || tabs.includes(current)) return null;
  return tabs[0]!;
}
