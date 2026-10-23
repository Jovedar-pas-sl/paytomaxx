'use client';

// Formas de cobro y ajustes de la noche del local (los pone el dueño en el
// panel → Ajustes). Lo apagado no se enseña aquí; el API además lo rechaza
// (409). Si no se pueden leer, se enseña todo y los ajustes de fábrica, como
// antes (el API sigue mandando).

import { createContext, useContext, useEffect, useState } from 'react';
import {
  DEFAULT_NIGHT_SETTINGS,
  DEFAULT_PAYMENT_METHODS,
  nightSettingsOf,
  paymentMethodsOf,
  type VenueNightSettings,
  type VenuePaymentMethods,
} from '@nightpay/contracts';
import { setVenueFeedback } from './alert-sound';
import { applySalaContrast } from './sala-contrast';
import { fetchVenueFeed } from './api';
import type { TabKey } from './roles';

export type CobroMode = 'qr' | 'wallet' | 'pos';

/**
 * Qué hace falta para cada forma de cobrar en Inicio. «wallet» es «Recargar
 * saldo» (un saldo que ya existe): con tarjeta, o en efectivo (con permiso), y
 * solo quien carga saldos (`canTopUp`: recepción, el encargado y el dueño).
 */
export function cobroModeAllowed(mode: CobroMode, m: VenuePaymentMethods, canTopUp = true): boolean {
  if (mode === 'qr') return m.card;
  if (mode === 'wallet') return canTopUp && m.wallet && (m.card || m.cashTopUp);
  return m.pos;
}

/**
 * Pestañas de abajo sin las de formas de cobro apagadas (Saldo, Recepción y
 * Datáfono); Recepción, además, solo a quien carga saldos.
 */
export function visibleTabsFor(tabs: readonly TabKey[], m: VenuePaymentMethods, canTopUp = true): TabKey[] {
  return tabs.filter((t) => {
    if (t === 'reception') return m.wallet && canTopUp;
    if (t === 'wallet') return m.wallet;
    return t === 'pos' ? m.pos : true;
  });
}

/** Lo que puede quien ha entrado, según su puesto (GET /v1/venues/me → myPost, myRights). */
export interface MyRights {
  /** RECEPCION, BARRA… (el dueño y el encargado: el suyo, si tienen). */
  post: string | null;
  /** Carga saldos: recepción, el encargado y el dueño (de fábrica). */
  topUps: boolean;
  /** Cobra en efectivo. */
  cash: boolean;
}

/** La respuesta del API → lo que puede (null: un API anterior que no lo dice). */
export function myRightsOf(post: unknown, rights: unknown): MyRights | null {
  if (!rights || typeof rights !== 'object') return null;
  const r = rights as { topUps?: unknown; cash?: unknown };
  if (typeof r.topUps !== 'boolean') return null;
  return { post: typeof post === 'string' ? post : null, topUps: r.topUps, cash: r.cash === true };
}

/**
 * ¿Ve «Recargar», la Recepción y el efectivo? Lo dice su puesto (el servidor
 * lo exige igual: assertCanTopUp). Sin saberlo aún (o con un API anterior),
 * el personal sí y la chica no: si no puede, el servidor lo dice.
 */
export function canTopUp(rights: MyRights | null, role: string): boolean {
  if (rights) return rights.topUps;
  return role !== 'OPERATOR';
}

/** Inicio del camarero, encargado o dueño: la cola «POS» solo si el local cobra con datáfono. */
export function staffHomeHint(m: Pick<VenuePaymentMethods, 'pos'>): string {
  const what = 'Cobra aquí la barra, las habitaciones o la comida.';
  return m.pos ? `${what} Los cobros con datáfono que crean las chicas te esperan en «POS».` : what;
}

export const VenueMethodsContext = createContext<VenuePaymentMethods>(DEFAULT_PAYMENT_METHODS);

export function useVenueMethods(): VenuePaymentMethods {
  return useContext(VenueMethodsContext);
}

/** Lo que puede quien ha entrado (null: aún no se sabe). */
export const MyRightsContext = createContext<MyRights | null>(null);

export function useMyRights(): MyRights | null {
  return useContext(MyRightsContext);
}

/** Ajustes de la noche (teclado del PIN, recepción…). De fábrica mientras no llegan. */
export const VenueNightContext = createContext<VenueNightSettings>(DEFAULT_NIGHT_SETTINGS);

export function useVenueNight(): VenueNightSettings {
  return useContext(VenueNightContext);
}

export interface VenueFeed {
  methods: VenuePaymentMethods;
  night: VenueNightSettings;
  rights: MyRights | null;
}

/** El almacenamiento del navegador, o null si no se deja (navegación privada estricta). */
function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Las formas de cobro, los ajustes de la noche y lo que puede quien entra, pedidos una vez al entrar (y si cambia el usuario). */
export function useVenueMethodsFeed(userId: string): VenueFeed {
  const [feed, setFeed] = useState<VenueFeed>({ methods: DEFAULT_PAYMENT_METHODS, night: DEFAULT_NIGHT_SETTINGS, rights: null });
  useEffect(() => {
    let cancelled = false;
    fetchVenueFeed()
      .then((venue) => {
        if (cancelled) return;
        const night = nightSettingsOf(venue.nightSettings);
        setVenueFeedback({ sound: night.feedbackSound, vibration: night.feedbackVibration });
        // Modo «sala» (contraste alto) si el local lo tiene; si no responde, se queda como estaba.
        applySalaContrast(document.documentElement, localStorageOrNull(), night.highContrast);
        setFeed({ methods: paymentMethodsOf(venue.paymentMethods), night, rights: myRightsOf(venue.myPost, venue.myRights) });
      })
      .catch(() => {
        // Sin respuesta: todo a la vista, como antes; el API rechaza lo apagado.
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return feed;
}
