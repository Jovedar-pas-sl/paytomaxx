import { ConflictException } from '@nestjs/common';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { YAVIN_SECOND_REFUND_CODE, YAVIN_SECOND_REFUND_TEXT } from '../gateways/yavin.adapter';

/** Un cobro de Yavin «Devolución BBVA»: el dinero no pasó por BBVA. */
export const YAVIN_BANK_REFUND_TEXT =
  'Este cobro se pagó con Yavin, no con BBVA: devuélvelo con «Devolver» (va por Yavin), no como devolución hecha en el banco.';

/**
 * Yavin admite UNA sola devolución por operación. Con la fila del cobro
 * bloqueada (FOR UPDATE), si ya hay una pedida o hecha (PENDING o SUCCEEDED),
 * la segunda no se pide: 409 con un mensaje claro. Una que falló (FAILED) no
 * cuenta: Yavin no la hizo.
 */
export async function assertYavinFirstRefund(
  tx: Pick<TransactionalClient, 'refund'>,
  payment: { id: string; provider: string | null },
): Promise<void> {
  if (payment.provider !== 'YAVIN') return;
  const previous = await tx.refund.count({ where: { paymentId: payment.id, status: { in: ['PENDING', 'SUCCEEDED'] } } });
  if (previous > 0) throw new ConflictException({ code: YAVIN_SECOND_REFUND_CODE, message: YAVIN_SECOND_REFUND_TEXT });
}

/** «Devolución BBVA» (hecha en el portal del banco) no vale para un cobro de Yavin. */
export function assertNotYavinBankRefund(provider: string | null | undefined): void {
  if (provider === 'YAVIN') throw new ConflictException({ code: 'YAVIN_REFUND_BY_GATEWAY', message: YAVIN_BANK_REFUND_TEXT });
}
