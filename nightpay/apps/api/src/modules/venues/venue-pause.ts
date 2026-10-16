import { HttpException } from '@nestjs/common';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * Local en pausa (o su negocio en pausa, consola del super-admin): no acepta
 * cobros nuevos (crear cobros, recargas de saldo, cobros del saldo). Lo demás
 * sigue: devoluciones, incidencias, cierre de la noche y entrar en las apps.
 */
export const VENUE_PAUSED_CODE = 'VENUE_PAUSED';

/** 423 Locked (Nest 10 no lo tiene en HttpStatus). */
export const VENUE_PAUSED_STATUS = 423;

/** Qué está en pausa: el propio local o el negocio al que pertenece. */
export type VenuePauseScope = 'venue' | 'business';

/** Lo que hace falta del local para saberlo (con VENUE_PAUSE_SELECT). */
export interface VenuePauseState {
  pausedAt: Date | null;
  business?: { status: string } | null;
}

/** `select` de Prisma para leer el estado de pausa junto con el resto del local. */
export const VENUE_PAUSE_SELECT = {
  pausedAt: true,
  business: { select: { status: true } },
} as const;

export const VENUE_PAUSED_MESSAGES: Readonly<Record<VenuePauseScope, string>> = {
  venue:
    'Este local está en pausa: ahora no se pueden hacer cobros, recargas de saldo ni cobros del saldo. ' +
    'Las devoluciones, las incidencias y el cierre de la noche siguen funcionando.',
  business:
    'El negocio de este local está en pausa: ahora no se pueden hacer cobros, recargas de saldo ni cobros del saldo. ' +
    'Las devoluciones, las incidencias y el cierre de la noche siguen funcionando.',
};

/** null si acepta cobros; si no, qué lo tiene en pausa (el local manda sobre el negocio). */
export function venuePauseScope(venue: VenuePauseState | null | undefined): VenuePauseScope | null {
  if (!venue) return null;
  if (venue.pausedAt) return 'venue';
  if (venue.business?.status === 'PAUSED') return 'business';
  return null;
}

/** 423 Locked con `code: VENUE_PAUSED` (las apps lo enseñan tal cual). */
export class VenuePausedException extends HttpException {
  constructor(scope: VenuePauseScope) {
    super(
      { error: 'Local en pausa', message: VENUE_PAUSED_MESSAGES[scope], code: VENUE_PAUSED_CODE, pausedBy: scope },
      VENUE_PAUSED_STATUS,
    );
  }
}

export function assertVenueNotPaused(venue: VenuePauseState | null | undefined): void {
  const scope = venuePauseScope(venue);
  if (scope) throw new VenuePausedException(scope);
}

/**
 * Lee el local y lanza 423 si está en pausa. Pásale un cliente con bypass
 * (asSystem): businesses solo se ve con él (RLS), y sin verlo un negocio en
 * pausa pasaría por activo.
 */
export async function assertVenueAcceptsCharges(db: Pick<TransactionalClient, 'venue'>, venueId: string): Promise<void> {
  const venue = await db.venue.findUnique({ where: { id: venueId }, select: VENUE_PAUSE_SELECT });
  assertVenueNotPaused(venue);
}
