import { useEffect, useId, useSyncExternalStore } from 'react';
import type { TabKey } from './roles';

/**
 * Cobros en pantalla: el QR de Inicio, el del saldo, la ficha NFC. Si la
 * sesión caduca con uno abierto, la app no se desmonta (se pide entrar otra
 * vez encima) para no perder el QR, su cuenta atrás y su «PAGADO».
 * Cada pantalla de cobro se apunta mientras está y se borra al cerrarse; cada
 * instancia por separado (el QR de una recarga dentro de Recepción no borra la
 * de Recepción al cerrarse).
 */
export type ChargeSpot = 'cobro' | 'saldo' | 'ficha' | 'recepcion';

/** Lo que apunta una instancia: en qué pantalla está y si sigue esperando. */
export interface ChargeEntry {
  readonly spot: ChargeSpot;
  readonly pending: boolean;
}

export interface OpenCharges {
  /** Hay algún cobro en pantalla (esperando, o con su resultado aún a la vista). */
  readonly open: boolean;
  /** Alguno sigue esperando al cliente o al banco. */
  readonly pending: boolean;
  /** Dónde están, en el orden en que se abrieron. */
  readonly spots: readonly ChargeSpot[];
}

const NONE: OpenCharges = { open: false, pending: false, spots: [] };

/** instancia → su pantalla y si espera. Las pantallas, sin repetir y en orden. */
export function summarizeCharges(entries: ReadonlyMap<string, ChargeEntry>): OpenCharges {
  if (entries.size === 0) return NONE;
  const all = [...entries.values()];
  return { open: true, pending: all.some((e) => e.pending), spots: [...new Set(all.map((e) => e.spot))] };
}

export interface OpenChargeStore {
  /** `instance`: quién se apunta (una por pantalla montada). null: ya no tiene cobro abierto. */
  set(instance: string, state: ChargeEntry | null): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): OpenCharges;
}

export function createOpenChargeStore(): OpenChargeStore {
  let entries: ReadonlyMap<string, ChargeEntry> = new Map();
  let snapshot = NONE;
  const listeners = new Set<() => void>();
  return {
    set(instance, state) {
      const prev = entries.get(instance);
      if (state === null ? prev === undefined : prev?.spot === state.spot && prev.pending === state.pending) return;
      const next = new Map(entries);
      if (state) next.set(instance, { spot: state.spot, pending: state.pending });
      else next.delete(instance);
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

/** Se apunta mientras `active`; al desmontarse, se borra (solo lo suyo). */
export function useOpenCharge(spot: ChargeSpot, active: boolean, pending: boolean, store: OpenChargeStore = openCharges): void {
  const instance = useId();
  useEffect(() => {
    store.set(instance, active ? { spot, pending } : null);
  }, [store, instance, spot, active, pending]);
  useEffect(() => () => store.set(instance, null), [store, instance]);
}

/** En qué pestaña vive cada cobro (la ficha sale encima de todas). */
const SPOT_TAB: Partial<Record<ChargeSpot, TabKey>> = { cobro: 'home', saldo: 'wallet', recepcion: 'reception' };

/**
 * La sesión caducó: si la pestaña que se ve no tiene el cobro abierto, a cuál
 * ir para tenerlo delante. null: quedarse.
 */
export function tabForOpenCharge(spots: readonly ChargeSpot[], current: TabKey): TabKey | null {
  const tabs = spots.map((s) => SPOT_TAB[s]).filter((t): t is TabKey => t !== undefined);
  if (tabs.length === 0 || tabs.includes(current)) return null;
  return tabs[0]!;
}
