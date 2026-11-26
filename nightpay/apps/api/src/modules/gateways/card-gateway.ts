import type { Provider } from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { yavinEnabled } from './yavin-flag';

/**
 * Qué pasarela de tarjeta cobra un cobro. Hoy cada local tiene la suya (Redsys,
 * BBVA): la primera credencial activa, como siempre. Yavin (enlace de pago con
 * QR) es una segunda pasarela que solo cuenta si:
 *  - el servidor la tiene encendida (YAVIN_ENABLED),
 *  - el super-admin la eligió para el local (venues.yavinSelected),
 *  - el local tiene una credencial YAVIN activa, y
 *  - es un cobro (sin saldo): las cargas de saldo y los reservados siguen con
 *    la pasarela de siempre.
 * Si falta algo, todo como hoy.
 */

/** Las credenciales de la pasarela «de siempre» del local: todas menos Yavin. */
export const BASE_GATEWAY_WHERE = { active: true, provider: { not: 'YAVIN' } } as const satisfies Prisma.GatewayCredentialWhereInput;

export interface CardGatewayOptions {
  /** La pasarela de siempre del local (null = no tiene). */
  base: Provider | null;
  /** Yavin se puede usar en este cobro (ver arriba). */
  yavin: boolean;
}

/**
 * La elección, en un solo sitio para poder cambiarla (p. ej. más adelante, por
 * proporción). Con Yavin elegido por el super-admin para el local, Yavin.
 */
export function chooseCardGateway(o: CardGatewayOptions): Provider | null {
  if (o.yavin) return 'YAVIN';
  return o.base;
}

type Db = Pick<Prisma.TransactionClient, 'gatewayCredential' | 'venue'>;

/** ¿Se puede cobrar con Yavin en este local? (servidor, super-admin y credencial). */
export async function yavinUsableIn(db: Db, tenantId: string): Promise<boolean> {
  if (!yavinEnabled()) return false;
  const venue = await db.venue.findUnique({ where: { id: tenantId }, select: { yavinSelected: true } });
  if (!venue?.yavinSelected) return false;
  const credential = await db.gatewayCredential.findFirst({ where: { tenantId, provider: 'YAVIN', active: true }, select: { id: true } });
  return credential !== null;
}

/** La pasarela de siempre del local (la primera credencial activa que no es Yavin). */
export async function baseGatewayOf(db: Db, tenantId: string): Promise<Provider | null> {
  const credential = await db.gatewayCredential.findFirst({
    where: { tenantId, ...BASE_GATEWAY_WHERE },
    orderBy: { createdAt: 'asc' },
    select: { provider: true },
  });
  return (credential?.provider as Provider | undefined) ?? null;
}

/** La pasarela que cobrará este cobro (null = el local no tiene ninguna). */
export async function cardGatewayFor(db: Db, payment: { tenantId: string; walletId: string | null }): Promise<Provider | null> {
  const base = await baseGatewayOf(db, payment.tenantId);
  const yavin = payment.walletId === null && (await yavinUsableIn(db, payment.tenantId));
  return chooseCardGateway({ base, yavin });
}
