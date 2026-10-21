import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  INVITATION_NOT_IN_CHARGE,
  INVITATION_QR_REQUIRED,
  INVITATION_TOKEN_INVALID,
  INVITATION_TOKEN_MISSING,
  invitationRulesOf,
  staffTokenFrom,
  type ChargeLineInput,
  type ChargeRights,
} from '@nightpay/contracts';
import { staffQrSecret, verifyStaffToken } from '../operators/staff-qr';
import { isInvitationLine, withInvitation } from './invitation-lines';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { assertSectionsAllowed, chargeRightsFor } from '../venues/charge-rights';
import {
  CHARGE_LINES_ERRORS,
  chargedSections,
  lineCommission,
  requestedItemIds,
  resolveChargeLines,
  type CartaItemLike,
  type DraftLine,
  type ResolvedCharge,
} from './charge-lines';
import { resolveBpsForOperator, type OperatorCommissionDefaults } from './commission';

/**
 * Lo que pide quien cobra (cobro con tarjeta o del saldo) → sus líneas, con
 * la carta y el puesto leídos de la base. El puesto decide también qué
 * secciones puede cobrar (403 si no). Errores como respuestas del API (404
 * servicio que no es de la carta del local; 400 el resto).
 */
export async function resolveChargeOrThrow(
  prisma: PrismaService,
  input: {
    tenantId: string;
    userId: string | null;
    role: string | null | undefined;
    lines?: readonly ChargeLineInput[] | null;
    serviceItemId?: string | null;
    amountCents?: number | null;
    requestedCategory?: string | null;
    /** «Invitar a una copa»: el QR personal de la chica invitada. */
    invitedStaffToken?: string | null;
    /** O la chica elegida de la lista (si el local no pide su QR). */
    invitedOperatorId?: string | null;
  },
): Promise<ResolvedCharge & { rights: ChargeRights | null }> {
  const ids = requestedItemIds(input);
  const userId = input.userId;
  const [rows, rights] = await prisma.asSystem(async (tx) =>
    Promise.all([
      ids.length > 0
        ? tx.serviceItem.findMany({
            where: { id: { in: ids }, tenantId: input.tenantId },
            select: {
              id: true,
              name: true,
              priceCents: true,
              durationMin: true,
              category: true,
              active: true,
              components: true,
              isInvitation: true,
            },
          })
        : Promise.resolve([]),
      userId ? chargeRightsFor(tx, input.tenantId, { userId, role: input.role }) : Promise.resolve(null),
    ]),
  );
  const items = new Map<string, CartaItemLike>(rows.map((r) => [r.id, r]));
  const request = {
    lines: input.lines,
    serviceItemId: input.serviceItemId,
    amountCents: input.amountCents,
    requestedCategory: input.requestedCategory,
    puesto: rights?.post ?? null,
    role: input.role,
    items,
  };
  const result = resolveChargeLines(request);
  if (!result.ok) {
    const message = CHARGE_LINES_ERRORS[result.reason];
    throw result.reason === 'item-missing' ? new NotFoundException(message) : new BadRequestException(message);
  }
  // El puesto: solo las secciones que puede cobrar (un pack, por su sección).
  if (rights) assertSectionsAllowed(rights, chargedSections(request));
  const lines = await invitationOf(prisma, input, items, result.charge.lines);
  return { ...result.charge, lines, rights };
}

/**
 * «Invitar a una copa»: si el cobro lleva una invitación de la carta, hace
 * falta el QR de la chica invitada (firmado, de su local, sin caducar); sus
 * líneas se quedan con ella y con las partes del local. Sin invitación, las
 * líneas tal cual (y un QR suelto sin invitación es un error: 400).
 */
async function invitationOf(
  prisma: PrismaService,
  input: {
    tenantId: string;
    userId: string | null;
    role: string | null | undefined;
    invitedStaffToken?: string | null;
    invitedOperatorId?: string | null;
  },
  items: ReadonlyMap<string, CartaItemLike>,
  lines: DraftLine[],
): Promise<DraftLine[]> {
  const invited = lines.some((l) => isInvitationLine(l, items));
  if (!invited && !input.invitedStaffToken && !input.invitedOperatorId) return lines;
  if (!invited) throw new BadRequestException(INVITATION_NOT_IN_CHARGE);
  const venue = await prisma.asSystem((tx) =>
    tx.venue.findUnique({ where: { id: input.tenantId }, select: { invitationRules: true } }),
  );
  const rules = invitationRulesOf(venue?.invitationRules);
  const chicaId = await invitedChicaId(input, rules.requireQr);
  const chica = await prisma.asSystem((tx) =>
    tx.user.findFirst({
      where: { id: chicaId, tenantId: input.tenantId, role: 'OPERATOR', deletedAt: null },
      select: { id: true },
    }),
  );
  if (!chica) throw new BadRequestException(INVITATION_TOKEN_INVALID);
  if (chica.id === input.userId) throw new BadRequestException('Una invitación es para otra chica, no para quien la cobra.');
  return withInvitation(lines, items, {
    beneficiaryOperatorId: chica.id,
    rules,
    // La parte de quien cobra, solo si es camarero (el dueño y el encargado: del local).
    chargerGetsShare: input.role === 'WAITER',
  });
}

/**
 * Quién es la chica invitada: su QR (firmado, de este local, sin caducar) o,
 * si el local no pide el QR (Ajustes → Invitaciones), la elegida de la lista.
 */
async function invitedChicaId(
  input: { tenantId: string; invitedStaffToken?: string | null; invitedOperatorId?: string | null },
  requireQr: boolean,
): Promise<string> {
  if (input.invitedOperatorId && !input.invitedStaffToken) {
    if (requireQr) throw new BadRequestException(INVITATION_QR_REQUIRED);
    return input.invitedOperatorId;
  }
  const token = input.invitedStaffToken ? staffTokenFrom(input.invitedStaffToken) : null;
  if (!token) throw new BadRequestException(INVITATION_TOKEN_MISSING);
  const who = verifyStaffToken(token, Date.now(), staffQrSecret());
  if (!who || who.tenantId !== input.tenantId) throw new BadRequestException(INVITATION_TOKEN_INVALID);
  return who.userId;
}

export type LineWithBps = DraftLine & { operatorCommissionBps: number | null };

/**
 * #54 por línea: el % de la chica fijado al crear el cobro (Servicios: el
 * suyo o el del local; el resto de secciones: el del local, normalmente 0).
 * Si no cobra una chica, sin %. `paymentBps` es el que se guarda en el cobro
 * (el de su sección si todas comparten %; si no, el efectivo).
 */
export function linesWithOperatorBps(
  lines: readonly DraftLine[],
  operator: { commissionBps: number | null; venueMap: Partial<OperatorCommissionDefaults> | null } | null,
): { lines: LineWithBps[]; paymentBps: number | null } {
  if (!operator) return { lines: lines.map((l) => ({ ...l, operatorCommissionBps: null })), paymentBps: null };
  const withBps = lines.map((l) => ({
    ...l,
    operatorCommissionBps: resolveBpsForOperator({
      category: l.category,
      userCommissionBpsOverride: operator.commissionBps,
      venueMap: operator.venueMap,
    }),
  }));
  const paymentBps = lineCommission(withBps.map((l) => ({ amountCents: l.amountCents, bps: l.operatorCommissionBps }))).commissionBps;
  return { lines: withBps, paymentBps };
}
