'use client';

// El detalle de un cobro recién pagado, para su ticket: las líneas, la tarjeta
// (marca y últimos 4), el saldo que le queda… Se pide una vez al salir el
// PAGADO; mientras no llega (o si falla), el ticket sale con lo que sabe la
// pantalla.

import { useEffect, useState } from 'react';
import type { CobroDetail, CobroKind } from '@nightpay/contracts';
import { fetchOwnCobroDetail } from './own-cobro-detail';

export interface PaidTarget {
  kind: CobroKind;
  id: string;
}

/** Cuál es el cobro pagado: con tarjeta, el pago; con el saldo (ficha, PIN, móvil), el cobro del saldo. */
export function paidTargetOf(
  paid: boolean,
  method: string | null,
  card: { id: string } | null,
  saldo: { chargeId: string } | null,
): PaidTarget | null {
  if (!paid) return null;
  if (method === 'card') return card ? { kind: 'PAYMENT', id: card.id } : null;
  return saldo ? { kind: 'SALDO', id: saldo.chargeId } : null;
}

/** El detalle del cobro pagado (null: aún no llega o no se pudo). */
export function usePaidDetail(target: PaidTarget | null): CobroDetail | null {
  const [detail, setDetail] = useState<CobroDetail | null>(null);
  const key = target ? `${target.kind}:${target.id}` : null;
  useEffect(() => {
    setDetail(null);
    if (!target) return undefined;
    const ctrl = new AbortController();
    fetchOwnCobroDetail(target.kind, target.id, ctrl.signal).then(
      (d) => setDetail(d.paidAt ? d : null),
      () => setDetail(null),
    );
    return () => ctrl.abort();
    // Una vez por cobro pagado.
  }, [key]);
  return detail;
}
