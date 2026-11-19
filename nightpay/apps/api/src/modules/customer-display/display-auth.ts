import { CUSTOMER_DISPLAY_AUTH_SCHEME, CUSTOMER_DISPLAY_PAIRING_TTL_MS, type JwtPayload } from '@nightpay/contracts';
import type { PrismaService, TransactionalClient } from '../../common/prisma/prisma.service';
import { nextNightCutoff } from '../../common/time/madrid';
import { sha256 } from './display-code';

/** La tablet que llama: solo lo justo para leer el cobro activo de su persona. */
export interface DisplaySession {
  id: string;
  tenantId: string;
  userId: string;
  /** El rol de su persona: con él paga la tablet su cobro (las mismas comprobaciones que su móvil). */
  role: JwtPayload['role'];
  /** Huella de la credencial con la que llamó (desemparejar solo esa). */
  tokenHash: string;
  expiresAt: Date;
  paymentId: string | null;
  chargeId: string | null;
  clearedAt: Date | null;
  lastSeenAt: Date | null;
  /** La propina que eligió el cliente en la tablet para ese cobro (0: «Sin propina»). */
  tipCents: number;
}

/**
 * Hasta cuándo vale una unión hecha ahora: el corte de la noche (las 08:00 de
 * Madrid, el mismo de los Z) y nunca más de 12 h. Cerrar la noche a mano
 * antes la corta también (nightClosedSince).
 */
export function pairingExpiresAt(now: Date): Date {
  const cap = now.getTime() + CUSTOMER_DISPLAY_PAIRING_TTL_MS;
  return new Date(Math.min(cap, nextNightCutoff(now).getTime()));
}

/** ¿Se cerró la noche del local después de emparejar? Entonces la unión ya no vale. */
export async function nightClosedSince(
  tx: Pick<TransactionalClient, 'venueNight'>,
  tenantId: string,
  pairedAt: Date | null,
): Promise<boolean> {
  if (!pairedAt) return false;
  const closed = await tx.venueNight.findFirst({ where: { tenantId, closedAt: { gt: pairedAt } }, select: { id: true } });
  return closed !== null;
}

const PREFIX = `${CUSTOMER_DISPLAY_AUTH_SCHEME} `;
/** Una credencial de verdad: 32 bytes en base64url (43 letras). Lo demás ni se busca. */
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** `Authorization: Pantalla <credencial>` → la credencial (o null). Un `Bearer` no vale aquí. */
export function displayTokenFromHeader(header: unknown): string | null {
  if (typeof header !== 'string' || !header.startsWith(PREFIX)) return null;
  return cleanToken(header.slice(PREFIX.length));
}

/** La credencial tal cual (handshake del tiempo real): solo con la forma de una de verdad. */
export function cleanToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  return TOKEN_RE.test(token) ? token : null;
}

/** El cobro que sigue ahora la pantalla: las salas del tiempo real. */
export function followedRooms(d: { paymentId: string | null; chargeId: string | null }): string[] {
  return [
    ...(d.paymentId ? [`payment:${d.paymentId.toLowerCase()}`] : []),
    ...(d.chargeId ? [`wallet-charge:${d.chargeId.toLowerCase()}`] : []),
  ];
}

/** Sala de las conexiones de una pantalla (avisos «vuelve a preguntar» y desemparejar). */
export function displayRoom(displayId: string): string {
  return `display:${displayId.toLowerCase()}`;
}

/**
 * La pantalla emparejada de esta credencial, si vale: sin revocar, sin
 * caducar, sin una noche cerrada desde que se emparejó y con su persona aún
 * en el local (de baja, no). Consulta de sistema (no hay usuario): el local
 * sale de la fila.
 */
export async function findActiveDisplay(
  prisma: Pick<PrismaService, 'asSystem'>,
  token: string,
  now: Date = new Date(),
): Promise<DisplaySession | null> {
  const tokenHash = sha256(token);
  const found = await prisma.asSystem(async (tx) => {
    const row = await tx.customerDisplay.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        pairedAt: true,
        expiresAt: true,
        revokedAt: true,
        paymentId: true,
        chargeId: true,
        clearedAt: true,
        lastSeenAt: true,
        tipCents: true,
        user: { select: { deletedAt: true, role: true } },
      },
    });
    const expiresAt = row?.expiresAt ?? null;
    if (!row || row.revokedAt || !expiresAt || expiresAt.getTime() <= now.getTime() || row.user.deletedAt) return null;
    return (await nightClosedSince(tx, row.tenantId, row.pairedAt)) ? null : { row, expiresAt };
  });
  if (!found) return null;
  const { row, expiresAt } = found;
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    role: row.user.role,
    tokenHash,
    expiresAt,
    paymentId: row.paymentId,
    chargeId: row.chargeId,
    clearedAt: row.clearedAt,
    lastSeenAt: row.lastSeenAt,
    tipCents: row.tipCents,
  };
}
