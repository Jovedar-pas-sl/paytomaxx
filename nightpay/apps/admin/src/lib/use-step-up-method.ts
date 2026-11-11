'use client';

// Con qué se verifica quien usa el panel (la 2FA, su llave o nada), pedido al
// abrir un diálogo que lo necesita. undefined: aún no se sabe (o no se pudo
// saber: entonces el API lo dice al intentarlo, PASSKEY_REQUIRED).

import { useEffect, useState } from 'react';
import type { StepUpMethod } from '@nightpay/contracts';
import { fetchStepUp } from './api';

export function useStepUpMethod(active: boolean): StepUpMethod | null | undefined {
  const [method, setMethod] = useState<StepUpMethod | null | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetchStepUp().then(
      (s) => {
        if (!cancelled) setMethod(s.method);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [active]);
  return method;
}
