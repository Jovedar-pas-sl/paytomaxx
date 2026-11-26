import { Prisma } from '@nightpay/db';

/** «No es mío» de la compañera (cobro por el encargado): lo apunta el registro y lo lee la incidencia service_disputed. */
export const SERVICE_DISPUTED_ACTION = 'operator.service_disputed';

/**
 * La ganancia `e` (alias de operator_earnings) es la de un servicio que le
 * cobró otra persona a su nombre: su ganancia normal (no una invitación) de un
 * cobro con una línea de Servicios suya (payment_lines.serviceOperatorId). Con
 * tarjeta o datáfono, las líneas siguen en el cobro; si pagó el saldo, en el
 * cobro del saldo de su consumo. payment_lines y wallet_charge_requests tienen
 * FORCE RLS: dentro de withTenant o asSystem. Sin parámetros: se puede repetir.
 */
export const SERVED_EARNING_SQL = Prisma.raw(`(e."paymentLineId" IS NULL AND (
  EXISTS (SELECT 1 FROM payment_lines se_l
           WHERE se_l."paymentId" = e."paymentId" AND se_l."serviceOperatorId" = e."operatorId")
  OR EXISTS (SELECT 1 FROM wallet_charge_requests se_w
               JOIN payment_lines se_l ON se_l."walletChargeId" = se_w.id
              WHERE se_w."consumptionId" = e."consumptionId" AND se_l."serviceOperatorId" = e."operatorId")))`);
