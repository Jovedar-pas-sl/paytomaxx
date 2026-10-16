import type { PrismaService } from '../../common/prisma/prisma.service';
import { resolveHoldDays } from './payout-math';

/** Solo lee `venues` (sin local ni FORCE RLS): vale el cliente raíz. */
type VenueReader = Pick<PrismaService, 'venue'>;

/**
 * Días de espera para pagar a las chicas de este local: la regla del local
 * (venues.payoutHoldDays, la pone el super-admin) o PAYOUT_HOLD_DAYS. La usan
 * el saldo de la chica, el pago (createPayout) y Tesorería: los tres cuentan igual.
 * Venue no va por local en el middleware: se lee con el id explícito.
 */
export async function venueHoldDays(db: VenueReader, envRaw: unknown, tenantId: string): Promise<number> {
  const venue = await db.venue.findUnique({ where: { id: tenantId }, select: { payoutHoldDays: true } });
  return resolveHoldDays(venue?.payoutHoldDays, envRaw);
}
