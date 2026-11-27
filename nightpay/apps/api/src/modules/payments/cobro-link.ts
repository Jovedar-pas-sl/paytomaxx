import { ConflictException } from '@nestjs/common';
import { ALREADY_PAID_CODE, ALREADY_PAID_MESSAGE } from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { applyEvent, type PaymentMachineState } from './payment.machine';

/**
 * Cobro único: un cobro con tarjeta (payments) y su cobro del saldo enlazado
 * (wallet_charge_requests.linkedPaymentId), con el mismo importe, la misma
 * referencia y un solo juego de líneas. La pantalla de espera enseña el QR y
 * espera el NFC a la vez: el cliente paga como quiera, y gana el primero.
 *
 * Los dos caminos bloquean PRIMERO la fila del cobro con tarjeta (FOR UPDATE),
 * siempre en este orden (cobro → saldo → cobro del saldo): no hay abrazo
 * mortal y nunca se pagan los dos.
 *  - Paga el saldo: el cobro con tarjeta pasa a CANCELED en la misma
 *    transacción (PAID_WITH_SALDO) y sus líneas pasan al cobro del saldo. Una
 *    aprobación del banco que llegue después no lo puede dar por pagado
 *    (late-card-approval: se devuelve sola o queda la incidencia).
 *  - Paga la tarjeta: transition() cancela el cobro del saldo; un NFC
 *    acercado después contesta «Ya está pagado» (ALREADY_PAID).
 */

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** payment_events del cobro con tarjeta cancelado porque lo pagó el saldo. */
export const PAID_WITH_SALDO_EVENT = 'payment.paid_with_saldo';

const PAID: ReadonlySet<string> = new Set(['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const CLOSED: ReadonlySet<string> = new Set(['EXPIRED', 'CANCELED']);

/** 409 «Ya está pagado» (code ALREADY_PAID): la otra forma de pago ganó. */
export function alreadyPaid(): ConflictException {
  return new ConflictException({ message: ALREADY_PAID_MESSAGE, code: ALREADY_PAID_CODE });
}

/** ¿El cobro con tarjeta ya se cobró (aunque luego se devolviera)? */
export function isCardPaid(status: string | null | undefined): boolean {
  return typeof status === 'string' && PAID.has(status);
}

/** El cobro con tarjeta bloqueado (FOR UPDATE) para decidir quién gana. */
export interface LinkedCardRow {
  id: string;
  tenantId: string;
  status: PaymentMachineState;
  amountCents: number;
  availableAmountCents: number;
  providerTxId: string | null;
  provider: 'WIPAY' | 'PEANPE' | 'PAYTEF' | 'REDSYS' | 'BTCPAY' | 'YAVIN' | null;
}

export async function lockLinkedCard(tx: RawTx, paymentId: string): Promise<LinkedCardRow | null> {
  const rows = await tx.$queryRaw<LinkedCardRow[]>`
    SELECT id::text AS id, "tenantId"::text AS "tenantId", status::text AS status,
           "amountCents", "availableAmountCents", "providerTxId", provider::text AS provider
      FROM payments
     WHERE id = ${paymentId}::uuid
     FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * ¿Puede pagarlo el saldo, con el cobro con tarjeta ya bloqueado? Pagado con
 * tarjeta → «Ya está pagado»; cancelado o caducado → ya no está pendiente.
 * En el banco (AUTHORIZING), sin confirmar (ORPHAN) o denegado (FAILED), sí:
 * el saldo gana y una aprobación tardía se devuelve o queda en Incidencias.
 */
export function saldoMayPay(card: Pick<LinkedCardRow, 'status'>): 'ok' | 'paid' | 'closed' {
  if (PAID.has(card.status)) return 'paid';
  if (CLOSED.has(card.status)) return 'closed';
  return 'ok';
}

/**
 * Las líneas del cobro pasan del cobro con tarjeta al del saldo que lo pagó
 * (un solo juego de líneas: el mapa del dinero y las comisiones las leen del
 * que se pagó). En la misma transacción que lo cobra: si algo falla, vuelven.
 */
export async function moveLinesToSaldo(tx: RawTx, paymentId: string, walletChargeId: string): Promise<number> {
  return tx.$executeRaw`
    UPDATE payment_lines
       SET "walletChargeId" = ${walletChargeId}::uuid, "paymentId" = NULL
     WHERE "paymentId" = ${paymentId}::uuid
  `;
}

/**
 * Pagado con el saldo: el cobro con tarjeta pasa a CANCELED (y ya no se
 * puede autorizar), con su evento. Con la fila ya bloqueada por
 * lockLinkedCard en la misma transacción.
 */
export async function cancelCardForSaldo(
  tx: RawTx,
  card: LinkedCardRow,
  walletChargeId: string,
  traceId: string,
): Promise<void> {
  const event = { type: 'PAID_WITH_SALDO' as const, walletChargeId };
  const result = applyEvent(
    card.status,
    {
      paymentId: card.id,
      amountCents: card.amountCents,
      availableAmountCents: card.availableAmountCents,
      providerTxId: card.providerTxId ?? undefined,
      provider: card.provider ?? undefined,
    },
    event,
  );
  // saldoMayPay ya lo miró: si no se puede, el cobro se deshace entero.
  if (!result) throw alreadyPaid();
  await tx.$executeRaw`
    UPDATE payments
       SET status = ${result.nextState}::"PaymentStatus", "updatedAt" = NOW()
     WHERE id = ${card.id}::uuid
  `;
  await tx.$executeRaw`
    INSERT INTO payment_events ("paymentId", "tenantId", "eventType", payload, "traceId")
    VALUES (${card.id}::uuid, ${card.tenantId}::uuid, ${PAID_WITH_SALDO_EVENT},
            ${JSON.stringify({ ...event, fromStatus: card.status })}::jsonb, ${traceId})
  `;
}

/**
 * El cobro con tarjeta terminó (pagado, cancelado o caducado): su cobro del
 * saldo, si sigue pendiente, también (un NFC acercado después ya no paga).
 * Dentro de transition(), con el cobro con tarjeta ya bloqueado.
 */
export async function closeLinkedSaldo(
  tx: RawTx,
  paymentId: string,
  cardState: PaymentMachineState,
): Promise<number> {
  const status = cardState === 'EXPIRED' ? 'EXPIRED' : cardState === 'AUTHORIZED' || cardState === 'CANCELED' ? 'CANCELED' : null;
  if (!status) return 0;
  return tx.$executeRaw`
    UPDATE wallet_charge_requests
       SET status = ${status}, "decidedAt" = NOW()
     WHERE "linkedPaymentId" = ${paymentId}::uuid AND status = 'PENDING'
  `;
}
