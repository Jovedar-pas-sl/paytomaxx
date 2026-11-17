'use client';

import { useEffect, useState } from 'react';
import type { BitcoinCashConfig } from '@nightpay/contracts';
import { fetchBitcoinCashConfig } from './endpoints/bitcoin-cash';

/**
 * El interruptor de «Devolver en efectivo» lo pagado con bitcoin y sus límites
 * (una vez por pantalla). Solo el encargado y el dueño lo piden; el resto, null.
 */
export function useBitcoinCash(role: string): BitcoinCashConfig | null {
  const [config, setConfig] = useState<BitcoinCashConfig | null>(null);
  useEffect(() => {
    if (role !== 'OWNER' && role !== 'MANAGER') return undefined;
    let alive = true;
    void fetchBitcoinCashConfig().then((c) => {
      if (alive) setConfig(c);
    });
    return () => {
      alive = false;
    };
  }, [role]);
  return config;
}
