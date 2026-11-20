import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, ForbiddenException, GoneException, type HttpException } from '@nestjs/common';
import { ACTIVATION_PATH_PREFIX, ACTIVATION_TOKEN_MINUTES } from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';

/**
 * El token del QR de activación (M-2, wallet_activation_tokens): aparte del
 * enlace permanente del saldo (qrToken). El QR de recepción (y el enlace nuevo
 * que da el dueño) llevan /w/a/<token>; con él, y solo una vez, el cliente
 * registra en SU móvil el primer Face ID o el primer PIN del saldo.
 *  - 24 bytes aleatorios (192 bits) en base64url: no se adivina.
 *  - En la base, solo su sha256: quien lea la base no rehace el enlace.
 *  - Vale ACTIVATION_TOKEN_MINUTES (10) y se gasta en la misma transacción
 *    que el registro: con dos registros a la vez, gana uno.
 *  - Emitir otro para el saldo anula los anteriores sin usar.
 * Mirarlo (GET /w/a/<token>) no lo gasta: las vistas previas de WhatsApp lo abren.
 */

export const ACTIVATION_TOKEN_TTL_MS = ACTIVATION_TOKEN_MINUTES * 60_000;
const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/**
 * Quién lo emite: el QR de «Cargado» de recepción, un enlace nuevo del dueño /
 * super-admin o «Guardar en mi móvil» del enlace de un regalo (home-topup).
 */
export type ActivationVia = 'reception' | 'relink' | 'gift';
/** Para qué se gastó: el primer Face ID (passkey) o el primer PIN. */
export type ActivationUse = 'passkey' | 'pin';
export type ActivationState = 'ok' | 'used' | 'expired';

export function newActivationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function activationTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** ¿Tiene la forma de un token de activación? (antes de tocar la base) */
export function isActivationToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/** /w/a/<token>: lo que va en el QR (con el origen del API delante). */
export function activationPath(token: string): string {
  return `${ACTIVATION_PATH_PREFIX}${token}`;
}

/** Vigente, usado o caducado (anulado por otro más nuevo cuenta como caducado). Sin fila, null. */
export function activationStateOf(
  row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date } | null,
  now: Date,
): ActivationState | null {
  if (!row) return null;
  if (row.usedAt) return 'used';
  if (row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'ok';
}

export const ACTIVATION_USED_MESSAGE = 'Este enlace ya se ha usado. Pide otro en recepción.';
export const ACTIVATION_EXPIRED_MESSAGE = 'Este enlace ha caducado. Pide otro en recepción.';
export const ACTIVATION_REQUIRED_MESSAGE = 'Para activarlo, pide en recepción el QR de activación.';

/** El error de un token que ya no vale: 409 si se usó, 410 si caducó, se anuló o no existe. */
export function activationError(state: ActivationState | null): HttpException {
  return state === 'used'
    ? new ConflictException({ message: ACTIVATION_USED_MESSAGE, code: 'ACTIVATION_USED' })
    : new GoneException({ message: ACTIVATION_EXPIRED_MESSAGE, code: 'ACTIVATION_EXPIRED' });
}

/**
 * Con el enlace permanente del saldo (/w/<qrToken>) ya no se registra el
 * primer Face ID ni el primer PIN: hace falta el QR de activación (o las vías
 * de siempre: el móvil que pagó la recarga, la chica o el encargado).
 */
export function activationRequired(): ForbiddenException {
  return new ForbiddenException({ message: ACTIVATION_REQUIRED_MESSAGE, code: 'ACTIVATION_REQUIRED' });
}

type TokenTx = Pick<Prisma.TransactionClient, 'walletActivationToken'>;

/** Emite uno nuevo para el saldo (y anula los anteriores sin usar). Devuelve el token: va al QR y no se guarda. */
export async function issueActivationToken(
  tx: TokenTx,
  input: { walletId: string; venueId: string | null; issuedById: string | null; via: ActivationVia; now?: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  await tx.walletActivationToken.updateMany({
    where: { walletId: input.walletId, usedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  const token = newActivationToken();
  const expiresAt = new Date(now.getTime() + ACTIVATION_TOKEN_TTL_MS);
  await tx.walletActivationToken.create({
    data: {
      walletId: input.walletId,
      tokenHash: activationTokenHash(token),
      venueId: input.venueId,
      issuedById: input.issuedById,
      via: input.via,
      createdAt: now,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

/**
 * Lo gasta, dentro de la transacción del registro (Face ID o PIN): solo si
 * está vigente. Con dos a la vez, la segunda espera a la fila y ya la ve
 * usada (409). Devuelve de qué saldo es.
 */
export async function spendActivationToken(
  tx: TokenTx,
  token: string,
  usedFor: ActivationUse,
  now: Date = new Date(),
): Promise<{ walletId: string }> {
  const tokenHash = activationTokenHash(token);
  const spent = await tx.walletActivationToken.updateMany({
    where: { tokenHash, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now, usedFor },
  });
  const row = await tx.walletActivationToken.findUnique({
    where: { tokenHash },
    select: { walletId: true, usedAt: true, revokedAt: true, expiresAt: true },
  });
  if (spent.count === 1 && row) return { walletId: row.walletId };
  throw activationError(activationStateOf(row, now) === 'used' ? 'used' : 'expired');
}
