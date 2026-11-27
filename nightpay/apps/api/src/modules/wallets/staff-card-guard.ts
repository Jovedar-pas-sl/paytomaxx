import { BadRequestException } from '@nestjs/common';
import { STAFF_CARD_NOT_CUSTOMER_CODE, STAFF_CARD_NOT_CUSTOMER_MESSAGE, isWalletCardToken } from '@nightpay/contracts';
import type { PrismaService, TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * La ficha de una compañera (cobro por el encargado, fase 2) lleva el mismo
 * enlace que las de los clientes, pero no es de ningún saldo. Si alguien la
 * acerca como la de un cliente (cobrar, recargar, mirar un saldo, darla a un
 * saldo), se dice claro qué es en lugar de «no es nuestra». Se llama solo
 * cuando la ficha no está entre las de los clientes.
 */
export function staffCardNotCustomer(): BadRequestException {
  return new BadRequestException({ message: STAFF_CARD_NOT_CUSTOMER_MESSAGE, code: STAFF_CARD_NOT_CUSTOMER_CODE });
}

/** Con una transacción de acrossVenues (la de cualquier local): lanza si es la ficha de una compañera (viva o anulada). */
export async function assertNotStaffCardTx(tx: Pick<TransactionalClient, 'staffCard'>, token: string): Promise<void> {
  if (!isWalletCardToken(token)) return;
  const staff = await tx.staffCard.findUnique({ where: { token }, select: { id: true } });
  if (staff) throw staffCardNotCustomer();
}

export async function assertNotStaffCard(db: Pick<PrismaService, 'acrossVenues'>, token: string): Promise<void> {
  if (!isWalletCardToken(token)) return;
  await db.acrossVenues((tx) => assertNotStaffCardTx(tx, token));
}
