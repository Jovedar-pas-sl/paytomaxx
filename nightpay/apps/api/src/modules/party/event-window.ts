import { HttpException } from '@nestjs/common';
import { EVENT_ENDED_CODE, EVENT_ENDED_MESSAGE, isEventEnded } from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { isPartyEdition } from '../../config/edition';

/**
 * OxioParty: con el fin de la fiesta (venues.eventEndsAt) ya pasado no se
 * crean cobros ni recargas nuevos. Las consultas, los cierres y las
 * devoluciones siguen (no pasan por aquí). Con EDITION=club no hace nada.
 */

/** 423 Locked, como un local en pausa: las apps enseñan el mensaje tal cual. */
export const EVENT_ENDED_STATUS = 423;

export class EventEndedException extends HttpException {
  constructor(endedAt: Date) {
    super(
      { error: 'Fiesta terminada', message: EVENT_ENDED_MESSAGE, code: EVENT_ENDED_CODE, endedAt: endedAt.toISOString() },
      EVENT_ENDED_STATUS,
    );
  }
}

/** Lanza 423 EVENT_ENDED si la fiesta ya terminó (solo con OxioParty). */
export function assertEventNotEnded(venue: { eventEndsAt: Date | null } | null | undefined, now: Date = new Date()): void {
  if (!isPartyEdition() || !venue?.eventEndsAt) return;
  if (isEventEnded(venue.eventEndsAt, now)) throw new EventEndedException(venue.eventEndsAt);
}

/**
 * Lee el fin de la fiesta y lanza 423 EVENT_ENDED si ya pasó. Con OxioPay
 * (EDITION=club) vuelve sin mirar la base: nada cambia.
 */
export async function assertEventOpen(db: Pick<TransactionalClient, 'venue'>, venueId: string, now: Date = new Date()): Promise<void> {
  if (!isPartyEdition()) return;
  const venue = await db.venue.findUnique({ where: { id: venueId }, select: { eventEndsAt: true } });
  assertEventNotEnded(venue, now);
}
