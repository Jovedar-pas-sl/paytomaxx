import { ConflictException } from '@nestjs/common';
import {
  PIN_REQUIRED_CODE,
  PIN_REQUIRED_MESSAGES,
  type PinRequiredReason,
  type VenueNightSettings,
} from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { lastNightCutoff } from '../../common/time/madrid';

/**
 * NFC sin PIN («Noche fácil»): un cobro del saldo con el NFC del cliente
 * (tarjeta, ficha o pulsera, leído con su número de serie) va sin PIN si
 *  - el importe no pasa del máximo sin PIN del local (20 € de fábrica), y
 *  - lo gastado sin PIN en esta noche + el importe no pasa del tope de la
 *    noche (100 € de fábrica).
 * La noche va de 08:00 a 08:00 de Madrid (como el cierre y los informes) y,
 * tras un PIN bueno, se vuelve a contar desde ese momento. Si el NFC se pierde,
 * lo más que se gasta sin PIN es ese tope CADA NOCHE, hasta que se bloquee o se
 * acabe el saldo (y el código y el número de serie se pueden copiar: no es una
 * ficha que no se pueda clonar). Lo cuenta el servidor con el saldo
 * bloqueado (FOR UPDATE): dos cobros a la vez no se saltan el tope.
 */

export type NoPinLimits = Pick<VenueNightSettings, 'nfcNoPinMaxCents' | 'nfcNoPinNightCapCents'>;

/** Desde cuándo se cuenta lo gastado sin PIN: el inicio de esta noche o el último PIN bueno (lo más tarde). */
export function noPinWindowStart(now: Date, resetAt: Date | null | undefined): Date {
  const night = lastNightCutoff(now);
  return resetAt && resetAt > night ? resetAt : night;
}

/** Por qué este cobro necesita el PIN (null: vale con el NFC solo). */
export function noPinProblem(input: { amountCents: number; spentCents: number; limits: NoPinLimits }): PinRequiredReason | null {
  const { amountCents, spentCents, limits } = input;
  if (limits.nfcNoPinMaxCents <= 0 || limits.nfcNoPinNightCapCents <= 0) return 'off';
  if (amountCents > limits.nfcNoPinMaxCents) return 'over_max';
  if (spentCents + amountCents > limits.nfcNoPinNightCapCents) return 'night_cap';
  return null;
}

/**
 * El NFC solo vale si se ha podido comprobar que es el original: el lector
 * mandó su número de serie y coincide con el guardado al darlo (o al ponerlo
 * en el stock). Uno distinto ya lo para la búsqueda (copia); sin número de
 * serie (un iPhone) o sin guardado, no se puede saber: PIN.
 */
export function noPinCardProblem(card: { uid: string | null }, readUid: string | null): PinRequiredReason | null {
  return card.uid && readUid && card.uid === readUid ? null : 'no_uid';
}

/** 409 PIN_REQUIRED: el mismo cobro sigue libre para pagarlo con el PIN. */
export class PinRequiredException extends ConflictException {
  constructor(readonly reason: PinRequiredReason) {
    super({ message: PIN_REQUIRED_MESSAGES[reason], code: PIN_REQUIRED_CODE, reason });
  }
}

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Lo cobrado sin PIN desde `since` en estos saldos (el del cliente y los
 * sumados a él), sin los consumos anulados. Dentro de la transacción del cobro,
 * con el saldo ya bloqueado.
 */
export async function noPinSpentSince(tx: RawTx, walletIds: readonly string[], since: Date): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ total: number }>>`
    SELECT COALESCE(SUM("amountCents" + "tipCents"), 0)::int AS total
      FROM wallet_consumptions
     WHERE "walletId" = ANY(${[...walletIds]}::uuid[])
       AND "authMethod" = 'nfc_nopin'
       AND "reversedAt" IS NULL
       AND "createdAt" >= ${since}
  `;
  return Number(rows[0]?.total ?? 0);
}
