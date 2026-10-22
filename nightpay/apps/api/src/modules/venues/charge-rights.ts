import { ForbiddenException } from '@nestjs/common';
import {
  CASH_PAYOUT_RECEPTION_ONLY_CODE,
  CASH_PAYOUT_RECEPTION_ONLY_MESSAGE,
  CASH_RECEPTION_ONLY_CODE,
  CASH_RECEPTION_ONLY_MESSAGE,
  SECTION_NOT_ALLOWED_CODE,
  TIPS_NOT_ALLOWED_CODE,
  TIPS_NOT_ALLOWED_MESSAGE,
  TOP_UP_RECEPTION_ONLY_CODE,
  TOP_UP_RECEPTION_ONLY_MESSAGE,
  canChargeSection,
  canPayOutCash,
  chargeRightsOf,
  postRulesOf,
  sectionMeta,
  sectionNotAllowedMessage,
  sectionsOf,
  staffCan,
  type ChargeRights,
  type StaffPermissions,
} from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { permissionDenied } from './staff-permission.guard';

/**
 * El puesto decide lo que cobra cada persona (Ajustes → Secciones →
 * Puestos): secciones, propinas, efectivo y recargas del saldo. Se comprueba
 * en el servidor en cada cobro; lo que no puede, 403 con el motivo en
 * castellano y su `code`.
 */

/** Lo que puede esta persona en este local (su puesto y la tabla del local). Con bypass: asSystem. */
export async function chargeRightsFor(
  db: Pick<TransactionalClient, 'user' | 'venue'>,
  tenantId: string,
  person: { userId: string; role: string | null | undefined },
): Promise<ChargeRights & { labelOf: (code: string) => string }> {
  const [user, venue] = await Promise.all([
    db.user.findFirst({ where: { id: person.userId }, select: { post: true } }),
    db.venue.findUnique({ where: { id: tenantId }, select: { postRules: true, sections: true } }),
  ]);
  const rights = chargeRightsOf({ role: person.role, post: user?.post ?? null }, postRulesOf(venue?.postRules));
  const sections = sectionsOf(venue?.sections);
  return { ...rights, labelOf: (code) => sectionMeta(sections, code).label };
}

/** 403 si alguna sección no la puede cobrar desde su puesto. */
export function assertSectionsAllowed(
  rights: ChargeRights & { labelOf: (code: string) => string },
  sections: readonly string[],
): void {
  const denied = sections.find((s) => !canChargeSection(rights, s));
  if (!denied) return;
  throw new ForbiddenException({
    message: sectionNotAllowedMessage(rights, denied, rights.labelOf),
    code: SECTION_NOT_ALLOWED_CODE,
    section: denied,
  });
}

/** «Las recargas se hacen en recepción» (chicas y camareros que no son de recepción). */
export function topUpForbidden(): ForbiddenException {
  return new ForbiddenException({ message: TOP_UP_RECEPTION_ONLY_MESSAGE, code: TOP_UP_RECEPTION_ONLY_CODE });
}

/**
 * Cargar saldo (con tarjeta, en efectivo o una recarga pendiente de
 * asignar): solo recepción, el encargado y el dueño (o el datáfono de
 * recepción, que no pasa por aquí). Si no, 403 «Las recargas se hacen en
 * recepción». Con bypass: asSystem.
 */
export async function assertCanTopUp(
  db: Pick<TransactionalClient, 'user' | 'venue'>,
  tenantId: string,
  person: { userId: string; role: string | null | undefined },
): Promise<void> {
  const rights = await chargeRightsFor(db, tenantId, person);
  if (!rights.topUps) throw topUpForbidden();
}

/** «El efectivo se cobra en recepción». */
export function cashForbidden(): ForbiddenException {
  return new ForbiddenException({ message: CASH_RECEPTION_ONLY_MESSAGE, code: CASH_RECEPTION_ONLY_CODE });
}

export function tipsForbidden(): ForbiddenException {
  return new ForbiddenException({ message: TIPS_NOT_ALLOWED_MESSAGE, code: TIPS_NOT_ALLOWED_CODE });
}

/**
 * Las recargas en efectivo, solo en recepción, el dueño y el encargado (las
 * devoluciones en efectivo, solo el encargado o el dueño: su ruta ya no deja más). El dueño, siempre; el encargado, con
 * su permiso de siempre (Ajustes → Permisos); el resto, si su puesto cobra
 * en efectivo y carga saldos (de fábrica, solo Recepción) y el dueño no se
 * lo ha quitado a esa persona en Permisos. Lanza el 403 que toca.
 */
export function assertCanHandleCash(
  rights: ChargeRights,
  person: { role: string; userId: string },
  perms: StaffPermissions,
): void {
  if (person.role === 'OWNER') return;
  if (person.role === 'MANAGER') {
    if (!staffCan(perms, person, 'cashTopUp')) throw permissionDenied('cashTopUp');
    return;
  }
  if (!rights.topUps) throw topUpForbidden();
  if (!rights.cash) throw cashForbidden();
  // Quitado a esa persona en Permisos.
  if (perms.people[person.userId]?.cashTopUp === false) throw permissionDenied('cashTopUp');
}

/**
 * Devolver el saldo en efectivo en la salida de recepción: un permiso aparte
 * de las recargas (canPayOutCash). El dueño, siempre; el encargado, con «Dar
 * efectivo»; el camarero, si su puesto lo hace (de fábrica, Recepción) y el
 * dueño no se lo ha quitado en Permisos. Lanza el 403 que toca.
 */
export function assertCanPayOutCash(
  rights: ChargeRights,
  person: { role: string; userId: string },
  perms: StaffPermissions,
): void {
  if (canPayOutCash(perms, person, rights)) return;
  if (person.role === 'MANAGER') throw permissionDenied('cash');
  if (person.role === 'WAITER' && rights.cashPayout) throw permissionDenied('cashPayout');
  throw new ForbiddenException({ message: CASH_PAYOUT_RECEPTION_ONLY_MESSAGE, code: CASH_PAYOUT_RECEPTION_ONLY_CODE });
}
