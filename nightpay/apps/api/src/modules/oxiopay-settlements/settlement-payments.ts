import { BadRequestException, ConflictException, type HttpException } from '@nestjs/common';
import {
  formatMoney,
  normalizeBankReference,
  settlementPaymentProblem,
  settlementPendingCents,
  type SettlementStatus,
} from '@nightpay/contracts';
import { madridDay } from '../../common/time/madrid';

export interface PaymentCheck {
  settlement: { status: SettlementStatus; totalCents: number; paidCents: number; periodFrom: Date };
  /** Los pagos ya apuntados en esta liquidación. */
  existing: ReadonlyArray<{ bankReference: string; amountCents: number; paidOn: Date }>;
  dto: { amountCents: number; paidOn: string; bankReference: string; reason?: string | null; confirmDuplicate?: boolean };
  /** Hoy en Madrid (AAAA-MM-DD). */
  today: string;
}

/**
 * Por qué no se puede apuntar este pago (la excepción a lanzar) o null. Se
 * mira antes del 2FA (para no gastar el código) y otra vez dentro de la
 * transacción, con la liquidación bloqueada.
 *  - Anulada o ya pagada entera: 409.
 *  - El día del abono, ni futuro ni anterior a la semana: 400.
 *  - Más de lo pendiente, o distinto sin motivo: 400 (settlementPaymentProblem).
 *  - La misma referencia del banco ya apuntada en esta liquidación: 409
 *    SETTLEMENT_PAYMENT_DUPLICATE, salvo que se confirme que es otro abono
 *    (un doble envío o un reintento no suma dos veces).
 */
export function paymentRefusal(c: PaymentCheck): HttpException | null {
  if (c.settlement.status === 'VOID') return new ConflictException('Esta liquidación está anulada: no se le apuntan pagos');
  if (c.settlement.status === 'PAID') return new ConflictException('Esta liquidación ya está pagada entera');
  if (c.dto.paidOn > c.today) return new BadRequestException('La fecha del pago no puede ser futura');
  if (c.dto.paidOn < madridDay(c.settlement.periodFrom)) {
    return new BadRequestException('La fecha del pago es anterior a la semana de la liquidación');
  }
  const problem = settlementPaymentProblem({
    pendingCents: settlementPendingCents(c.settlement),
    amountCents: c.dto.amountCents,
    reason: c.dto.reason,
  });
  if (problem) return new BadRequestException(problem);
  const ref = normalizeBankReference(c.dto.bankReference);
  const same = c.existing.find((p) => normalizeBankReference(p.bankReference) === ref);
  if (same && !c.dto.confirmDuplicate) {
    return new ConflictException({
      message: `Ya hay un pago con la referencia ${same.bankReference} en esta liquidación (${formatMoney(same.amountCents)}, del ${same.paidOn.toISOString().slice(0, 10)}). Si es otro abono, confírmalo.`,
      code: 'SETTLEMENT_PAYMENT_DUPLICATE',
    });
  }
  return null;
}
