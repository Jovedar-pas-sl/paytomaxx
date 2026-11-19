import { useState } from 'react';
import { fetchUnpaidCobros, type UnpaidRow } from '@/lib/api-sin-pagar';
import { withCancelableAt } from '@/lib/cancel-at-bank';
import { usePolling } from '@/lib/use-polling';

/**
 * Los cobros sin pagar del local (GET /payments/sin-pagar), cada 10 s, con la
 * hora a la que se podrá cancelar cada uno en su banco (en el reloj de este
 * móvil, fija mientras siga en la misma visita al banco: sin parpadeos). Lo
 * usan «Sin pagar en el local» y, para los suyos, la lista de la chica.
 */
export function useUnpaidInVenue(): { items: UnpaidRow[] | null; refresh: () => void } {
  const [items, setItems] = useState<UnpaidRow[] | null>(null);
  const refresh = usePolling(
    async (signal) => {
      const fresh = await fetchUnpaidCobros(signal);
      const receivedAt = Date.now();
      setItems((previous) => withCancelableAt(previous, fresh, receivedAt));
      return undefined;
    },
    { intervalMs: 10_000, timeoutMs: 30_000 },
  );
  return { items, refresh };
}
