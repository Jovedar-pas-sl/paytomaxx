import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  MINOR_CANNOT_ACTIVATE,
  PAYOUT_HOLDER_UNCONFIRMED,
  holderMatchesName,
  isMinor,
  madridToday,
  maskHolderName,
  type OxiocardStatus,
  type OxiocardView,
} from '@nightpay/contracts';
import { openPayoutValue, sealPayoutValue } from './payout-account-crypto';

/**
 * Nombre legal y fecha de nacimiento de la compañera (alta con tres caminos,
 * 19-nov-2026). El nombre va cifrado como la cuenta de cobro (pa1:…, con
 * ENCRYPTION_KEK y su propio campo); la fecha, como DATE. Ninguno va en claro
 * al registro. Con menos de 18 años no se activa la cuenta. Si el titular de
 * su cuenta no coincide con su nombre legal, no se le paga a esa cuenta hasta
 * que el dueño confirme que es suya. Lógica pura.
 */

export function sealLegalName(userId: string, name: string, kek: string | undefined = process.env.ENCRYPTION_KEK): string {
  return sealPayoutValue(name, { userId, field: 'legalName' }, kek);
}

/**
 * Guardar otro nombre legal: cifrado, y la confirmación del titular deja de
 * valer (era para el de antes). El mismo de antes, nada.
 */
export function legalNameData(
  row: { id: string; legalName?: string | null },
  name: string,
): { legalName?: string; payoutHolderConfirmedAt?: null } {
  if (legalNameView(row).plain === name) return {};
  return { legalName: sealLegalName(row.id, name), payoutHolderConfirmedAt: null };
}

/** Su fecha nueva la hace menor (con la misma de antes ya se cerró su acceso). */
export function becomesMinor(stored: Date | null | undefined, birthDate: string | undefined, now: Date): boolean {
  return birthDate !== undefined && birthDate !== birthDateOf(stored) && isMinor(birthDate, madridToday(now));
}

/** En claro (solo en memoria) y tapado. Si no se puede abrir (otra clave), solo «••••». */
export function legalNameView(
  row: { id: string; legalName?: string | null },
  kek: string | undefined = process.env.ENCRYPTION_KEK,
): { plain: string | null; masked: string | null } {
  if (!row.legalName) return { plain: null, masked: null };
  try {
    const plain = openPayoutValue(row.legalName, { userId: row.id, field: 'legalName' }, kek);
    return { plain, masked: maskHolderName(plain) };
  } catch {
    return { plain: null, masked: '••••' };
  }
}

/** La columna DATE (Prisma la da a las 00:00 UTC) como «AAAA-MM-DD». */
export function birthDateOf(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** «AAAA-MM-DD» para guardarlo en la columna DATE. */
export function birthDateValue(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** Tiene menos de 18 años hoy (en Madrid). Sin fecha, no. */
export function minorNow(birthDate: Date | null | undefined, now: Date = new Date()): boolean {
  return isMinor(birthDateOf(birthDate), madridToday(now));
}

export function minorCannotActivate(): ForbiddenException {
  return new ForbiddenException({
    code: MINOR_CANNOT_ACTIVATE,
    message: 'Con menos de 18 años no se puede activar la cuenta.',
  });
}

/**
 * Lo que se guarda al saber que es menor: una contraseña que no vale (cierra
 * la que tuviera), pendiente de activar, sin enlace de invitación y bloqueada.
 * Para volver a entrar, el dueño le manda otra invitación, y no se acepta
 * mientras sea menor.
 */
export function minorLockData(
  row: { invitedAt: Date | null },
  now: Date,
  placeholderHash: string,
): { passwordHash: string; invitedAt: Date; inviteToken: null; onboardingStatus: 'BLOCKED' } {
  return { passwordHash: placeholderHash, invitedAt: row.invitedAt ?? now, inviteToken: null, onboardingStatus: 'BLOCKED' };
}

/** Su OxioCard para su app. */
export function oxiocardView(row: { oxiocardStatus: string; oxiocardStatusAt: Date | null }): OxiocardView {
  return { status: row.oxiocardStatus as OxiocardStatus, at: row.oxiocardStatusAt?.toISOString() ?? null };
}

export interface HolderCheckRow {
  id: string;
  displayName?: string | null;
  payoutMetadata: unknown;
  legalName: string | null;
  payoutHolderConfirmedAt: Date | null;
}

/**
 * El titular de su cuenta no coincide con su nombre legal y el dueño aún no
 * lo ha confirmado. Sin nombre legal o sin titular, no hay nada que confirmar
 * (el panel avisa contra su nombre de siempre). Si no se puede abrir, que lo
 * confirme el dueño.
 */
export function payoutHolderUnconfirmed(row: HolderCheckRow, kek: string | undefined = process.env.ENCRYPTION_KEK): boolean {
  const holder = (row.payoutMetadata as { accountHolder?: unknown } | null)?.accountHolder;
  if (row.payoutHolderConfirmedAt || !row.legalName || typeof holder !== 'string' || !holder) return false;
  try {
    const plainHolder = openPayoutValue(holder, { userId: row.id, field: 'holder' }, kek);
    const legal = openPayoutValue(row.legalName, { userId: row.id, field: 'legalName' }, kek);
    return !holderMatchesName(plainHolder, legal);
  } catch {
    return true;
  }
}

/**
 * «Marcar pagado» (o pedirlo) a una cuenta con el titular sin confirmar: 409.
 * En efectivo, sí; por cualquier otra vía, no (como la espera de 48 h).
 */
export function payoutHolderNotConfirmed(
  person: HolderCheckRow,
  rail: string | null,
  kek: string | undefined = process.env.ENCRYPTION_KEK,
): ConflictException | null {
  if (rail === 'MANUAL_CASH' || !payoutHolderUnconfirmed(person, kek)) return null;
  const name = person.displayName?.trim();
  return new ConflictException({
    code: PAYOUT_HOLDER_UNCONFIRMED,
    message:
      `El titular de la cuenta de cobro${name ? ` de ${name}` : ''} no coincide con su nombre legal: ` +
      'confirma en su ficha (Editar → Cuenta de cobro) que la cuenta es suya antes de pagarle a ella. En efectivo, sí se le puede pagar ya.',
  });
}
