import { ConflictException } from '@nestjs/common';
import {
  PAYMENT_METHOD_DISABLED_CODE,
  PAYMENT_METHOD_DISABLED_MESSAGES,
  TIPS_DISABLED_CODE,
  TIPS_DISABLED_MESSAGE,
  disabledMethod,
  paymentMethodsOf,
  type PaymentMethodKey,
  type VenuePaymentMethods,
} from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * Formas de cobro del local (Ajustes → Formas de cobro). Una apagada da 409
 * con `code: PAYMENT_METHOD_DISABLED` y `method`; la propina apagada,
 * `TIPS_DISABLED`. Las apps lo enseñan tal cual (mensaje en castellano).
 */

/**
 * Lo que se guarda al dar de alta un local: lo de siempre con el datáfono
 * apagado (casi ningún local nuevo lo usa; se enciende en Formas de cobro).
 * DEFAULT_PAYMENT_METHODS no cambia: un local de antes sin nada guardado
 * sigue con el datáfono encendido, como hasta ahora.
 */
export function newVenuePaymentMethods(): VenuePaymentMethods {
  return { ...paymentMethodsOf(null), pos: false };
}

/** `select` de Prisma para leerlas junto con el resto del local. */
export const VENUE_METHODS_SELECT = { paymentMethods: true } as const;

export class PaymentMethodDisabledException extends ConflictException {
  constructor(method: PaymentMethodKey) {
    super({
      error: 'Forma de cobro apagada',
      message: PAYMENT_METHOD_DISABLED_MESSAGES[method],
      code: PAYMENT_METHOD_DISABLED_CODE,
      method,
    });
  }
}

export class TipsDisabledException extends ConflictException {
  constructor() {
    super({ error: 'Propinas apagadas', message: TIPS_DISABLED_MESSAGE, code: TIPS_DISABLED_CODE });
  }
}

/** 409 si alguna de las formas de cobro que hacen falta está apagada. */
export function assertMethodsEnabled(
  venue: { paymentMethods: unknown } | null | undefined,
  needed: readonly PaymentMethodKey[],
): VenuePaymentMethods {
  const methods = paymentMethodsOf(venue?.paymentMethods);
  const off = disabledMethod(methods, needed);
  if (off) throw new PaymentMethodDisabledException(off);
  return methods;
}

/** Lee el local y lanza 409 si alguna está apagada (cliente con bypass: asSystem). */
export async function assertVenueAcceptsMethods(
  db: Pick<TransactionalClient, 'venue'>,
  venueId: string,
  needed: readonly PaymentMethodKey[],
): Promise<VenuePaymentMethods> {
  const venue = await db.venue.findUnique({ where: { id: venueId }, select: VENUE_METHODS_SELECT });
  return assertMethodsEnabled(venue, needed);
}
