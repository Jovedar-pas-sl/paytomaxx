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

/** Lo que el personal puede elegir al cobrar. */
export type CardGatewayRequest = 'REDSYS' | 'YAVIN';

export interface CardGatewayOptions {
  /** La pasarela de siempre del local (null = no tiene). */
  base: Provider | null;
  /** Yavin se puede usar en este cobro (ver arriba). */
  yavin: boolean;
  /** Lo que eligió el camarero en la app del personal (null = no eligió). */
  requested?: CardGatewayRequest | null;
}

/**
 * LA elección, en un solo sitio para poder cambiarla. Decisión del dueño:
 *  - con las dos (BBVA y Yavin), la que eligió el camarero; sin elegir, BBVA;
 *  - con una sola, esa (lo que pida el camarero no cuenta);
 *  - sin Yavin, todo como hoy.
 * Más adelante se repartirá por proporción (p. ej. 5 BBVA por 1 Yavin): será
 * aquí, sin tocar nada más.
 */
export function chooseCardGateway(o: CardGatewayOptions): Provider | null {
  if (!o.yavin) return o.base;
  if (!o.base) return 'YAVIN';
  return o.requested === 'YAVIN' ? 'YAVIN' : o.base;
}

/** Entre qué elige el personal: dos botones solo si el local tiene las dos. */
export function cardGatewayChoices(o: Omit<CardGatewayOptions, 'requested'>): CardGatewayRequest[] {
  return o.yavin && o.base === 'REDSYS' ? ['REDSYS', 'YAVIN'] : [];
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
export async function cardGatewayFor(
  db: Db,
  payment: { tenantId: string; walletId: string | null; cardGateway?: string | null },
): Promise<Provider | null> {
  const base = await baseGatewayOf(db, payment.tenantId);
  const yavin = payment.walletId === null && (await yavinUsableIn(db, payment.tenantId));
  const requested = payment.cardGateway === 'YAVIN' || payment.cardGateway === 'REDSYS' ? payment.cardGateway : null;
  return chooseCardGateway({ base, yavin, requested });
}

/** Lo que ve la app del personal al cobrar en este local. */
export async function cardGatewayChoicesIn(db: Db, tenantId: string): Promise<CardGatewayRequest[]> {
  const base = await baseGatewayOf(db, tenantId);
  return cardGatewayChoices({ base, yavin: await yavinUsableIn(db, tenantId) });
}
