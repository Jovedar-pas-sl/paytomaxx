import { useEffect } from 'react';
import { clearDisplay, showOnDisplay } from '@/lib/customer-display-api';
import { isPractice } from '@/lib/practice';

/**
 * La «Pantalla del cliente» de quien cobra enseña este cobro mientras la
 * pantalla que lo espera está montada (Esperando, la recarga de recepción);
 * al salir, vuelve al reposo (tras su «Pagado» si se pagó). Sin pantalla
 * emparejada, el API no hace nada. Es un extra: si falla, el cobro sigue
 * igual (no se avisa al camarero ni se reintenta).
 */
export function useCustomerDisplay(target: { paymentId?: string | null; chargeId?: string | null } | null): void {
  const paymentId = target?.paymentId ?? null;
  const chargeId = target?.chargeId ?? null;
  useEffect(() => {
    if ((!paymentId && !chargeId) || isPractice()) return undefined;
    const ids = { paymentId, chargeId };
    let shown = false;
    let left = false;
    const leave = () => void clearDisplay(ids).catch(() => undefined);
    showOnDisplay(ids)
      .then((status) => {
        shown = status.paired;
        // Ya se salió del cobro antes de que llegara la respuesta.
        if (left && shown) leave();
      })
      .catch(() => undefined);
    return () => {
      left = true;
      if (shown) leave();
    };
  }, [paymentId, chargeId]);
}
