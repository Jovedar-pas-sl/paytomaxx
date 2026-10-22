import { ConflictException, HttpException } from '@nestjs/common';
import type { Prisma } from '@nightpay/db';
import { assertRefundIntent, type RefundIntention } from './refund-intent';

/** Lo que devuelve una devolución hecha (201). */
export interface RefundResult {
  id: string;
  paymentId: string;
  amountCents: number;
  status: 'SUCCEEDED';
  providerRefundId: string | null;
}

/** La misma, devuelta otra vez a un reintento con su clave: no se ha devuelto dos veces. */
export type RefundReplay = RefundResult & { replayed: true };

/** La fila con lo necesario para repetir su respuesta. */
export interface ReplayableRefund {
  id: string;
  paymentId: string;
  amountCents: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  providerRefundId: string | null;
  intentFingerprint: string | null;
  replayResponse: Prisma.JsonValue | null;
}

/** Respuesta guardada en la fila para repetirla igual. */
export function savedResponse(statusCode: number, body: object): Prisma.InputJsonValue {
  return { statusCode, body } as unknown as Prisma.InputJsonValue;
}

function readSaved(value: Prisma.JsonValue | null): { statusCode: number; body: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { statusCode, body } = value as Record<string, unknown>;
  if (typeof statusCode !== 'number' || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  return { statusCode, body: body as Record<string, unknown> };
}

/**
 * Lo que pasó con la devolución de esta clave, como la primera vez (o 409 si
 * la clave es de otra intención). Hecha: la misma respuesta. Rechazada por la
 * pasarela: el mismo 409 (la pantalla empieza otra). Sin confirmar: el mismo
 * 502 hasta que el dueño la resuelva. En curso: 409 para reintentar luego.
 */
export function replayOfRefund(row: ReplayableRefund, request: RefundIntention, actor: { userId: string }): RefundReplay {
  assertRefundIntent(row.intentFingerprint, request, actor, row);
  const saved = readSaved(row.replayResponse);
  if (row.status === 'SUCCEEDED') {
    const body = saved?.statusCode === 201 ? (saved.body as unknown as RefundResult) : null;
    return {
      ...(body ?? { id: row.id, paymentId: row.paymentId, amountCents: row.amountCents, status: 'SUCCEEDED', providerRefundId: row.providerRefundId }),
      replayed: true,
    };
  }
  if (row.status === 'FAILED') {
    if (saved?.statusCode === 409) throw new HttpException(saved.body, 409);
    throw new ConflictException({
      message: 'Esta devolución no se hizo (se marcó como no hecha). Para intentarla otra vez, empieza una devolución nueva.',
      code: 'REFUND_FAILED',
      refundId: row.id,
    });
  }
  if (saved && saved.statusCode !== 201) throw new HttpException(saved.body, saved.statusCode);
  throw new ConflictException({
    message: 'La devolución sigue en curso. Vuelve a confirmar en un momento para ver en qué quedó.',
    code: 'REFUND_IN_PROGRESS',
    refundId: row.id,
  });
}
