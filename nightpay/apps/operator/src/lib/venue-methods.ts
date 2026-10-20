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
import { fetchVenueFeed } from './api';
import type { TabKey } from './roles';

export type CobroMode = 'qr' | 'wallet' | 'pos';

/**
 * Qué hace falta para cada forma de cobrar en Inicio. «wallet» es «Recargar
 * saldo» (un saldo que ya existe): con tarjeta, o en efectivo (con permiso).
 */
export function cobroModeAllowed(mode: CobroMode, m: VenuePaymentMethods): boolean {
  if (mode === 'qr') return m.card;
  if (mode === 'wallet') return m.wallet && (m.card || m.cashTopUp);
  return m.pos;
}

/** Pestañas de abajo sin las de formas de cobro apagadas (Saldo, Recepción y Datáfono). */
export function visibleTabsFor(tabs: readonly TabKey[], m: VenuePaymentMethods): TabKey[] {
  return tabs.filter((t) => (t === 'wallet' || t === 'reception' ? m.wallet : t === 'pos' ? m.pos : true));
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

/** Ajustes de la noche (teclado del PIN, recepción…). De fábrica mientras no llegan. */
export const VenueNightContext = createContext<VenueNightSettings>(DEFAULT_NIGHT_SETTINGS);

export function useVenueNight(): VenueNightSettings {
  return useContext(VenueNightContext);
}

export interface VenueFeed {
  methods: VenuePaymentMethods;
  night: VenueNightSettings;
}

/** Las formas de cobro y los ajustes de la noche del local, pedidos una vez al entrar (y si cambia el usuario). */
export function useVenueMethodsFeed(userId: string): VenueFeed {
  const [feed, setFeed] = useState<VenueFeed>({ methods: DEFAULT_PAYMENT_METHODS, night: DEFAULT_NIGHT_SETTINGS });
  useEffect(() => {
    let cancelled = false;
    fetchVenueFeed()
      .then((venue) => {
        if (cancelled) return;
        const night = nightSettingsOf(venue.nightSettings);
        setVenueFeedback({ sound: night.feedbackSound, vibration: night.feedbackVibration });
        setFeed({ methods: paymentMethodsOf(venue.paymentMethods), night });
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
