'use client';

import { useEffect, useState } from 'react';
import { Button } from '@nightpay/ui';
import type { OwnerSettlementNotice } from '@nightpay/contracts';
import { fetchOwnerSettlementNotice } from '@/lib/endpoints/oxiopay-settlements';
import { overdueNoticeText } from '@/lib/oxiopay-settlements';
import '../../styles/panel-liquidacion.css';

/** Cada cuánto se vuelve a mirar (el aviso es de días: no hace falta más). */
const REFRESH_MS = 15 * 60 * 1000;

/**
 * Aviso de arriba del panel del dueño: una liquidación OxioPay lleva más de
 * 7 días sin pagar. Solo el dueño (quien lo pinta lo comprueba; el API también).
 */
export function OverdueSettlementsBanner({ tenantId, onOpen }: { tenantId: string; onOpen: () => void }) {
  const [notice, setNotice] = useState<OwnerSettlementNotice | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      fetchOwnerSettlementNotice(controller.signal)
        .then(setNotice)
        .catch(() => {
          // Sin respuesta no se avisa (la pestaña lo enseña con su error).
        });
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [tenantId]);

  const text = overdueNoticeText(notice);
  if (!text) return null;
  return (
    <div role="status" className="np-liq-banner">
      <p>
        <strong>Liquidación OxioPay sin pagar.</strong> {text} Págala por transferencia con su referencia.
      </p>
      <Button type="button" onClick={onOpen}>
        Ver liquidaciones
      </Button>
    </div>
  );
}
