import { CUSTOMER_DISPLAY_AUTH_SCHEME } from '@nightpay/contracts';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { sha256 } from './display-code';

/** La tablet que llama: solo lo justo para leer el cobro activo de su persona. */
export interface DisplaySession {
  id: string;
  tenantId: string;
  userId: string;
  /** Huella de la credencial con la que llamó (desemparejar solo esa). */
  tokenHash: string;
  expiresAt: Date;
  paymentId: string | null;
  chargeId: string | null;
  clearedAt: Date | null;
  lastSeenAt: Date | null;
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
 * caducar y con su persona aún en el local (de baja, no). Consulta de
 * sistema (no hay usuario): el local sale de la fila.
 */
export async function findActiveDisplay(
  prisma: Pick<PrismaService, 'asSystem'>,
  token: string,
  now: Date = new Date(),
): Promise<DisplaySession | null> {
  const tokenHash = sha256(token);
  const row = await prisma.asSystem((tx) =>
    tx.customerDisplay.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        paymentId: true,
        chargeId: true,
        clearedAt: true,
        lastSeenAt: true,
        user: { select: { deletedAt: true } },
      },
    }),
  );
  if (!row || row.revokedAt || !row.expiresAt || row.expiresAt.getTime() <= now.getTime()) return null;
  if (row.user.deletedAt) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    tokenHash,
    expiresAt: row.expiresAt,
    paymentId: row.paymentId,
    chargeId: row.chargeId,
    clearedAt: row.clearedAt,
    lastSeenAt: row.lastSeenAt,
  };
}
