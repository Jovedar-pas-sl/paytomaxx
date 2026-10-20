'use client';

// Formas de cobro del local (las pone el dueño en el panel → Ajustes). Lo
// apagado no se enseña aquí; el API además lo rechaza (409). Si no se pueden
// leer, se enseña todo, como antes (el API sigue mandando).

import { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_PAYMENT_METHODS, paymentMethodsOf, type VenuePaymentMethods } from '@nightpay/contracts';
import { fetchVenueMethods } from './api';
import type { TabKey } from './roles';

export type CobroMode = 'qr' | 'wallet' | 'pos';

/** Qué hace falta para cada forma de cobrar en «Crear cobro» (la recarga es con tarjeta). */
export function cobroModeAllowed(mode: CobroMode, m: VenuePaymentMethods): boolean {
  if (mode === 'qr') return m.card;
  if (mode === 'wallet') return m.card && m.wallet;
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

/** Las formas de cobro del local, pedidas una vez al entrar (y si cambia el usuario). */
export function useVenueMethodsFeed(userId: string): VenuePaymentMethods {
  const [methods, setMethods] = useState<VenuePaymentMethods>(DEFAULT_PAYMENT_METHODS);
  useEffect(() => {
    let cancelled = false;
    fetchVenueMethods()
      .then((m) => {
        if (!cancelled) setMethods(paymentMethodsOf(m));
      })
      .catch(() => {
        // Sin respuesta: todo a la vista, como antes; el API rechaza lo apagado.
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return methods;
}
