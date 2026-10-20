import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ChargeLineInput } from '@nightpay/contracts';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  CHARGE_LINES_ERRORS,
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
 * la carta y el puesto leídos de la base. Errores como respuestas del API
 * (404 servicio que no es de la carta del local; 400 el resto).
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
  },
): Promise<ResolvedCharge> {
  const ids = requestedItemIds(input);
  const userId = input.userId;
  const [rows, user] = await prisma.asSystem(async (tx) =>
    Promise.all([
      ids.length > 0
        ? tx.serviceItem.findMany({
            where: { id: { in: ids }, tenantId: input.tenantId },
            select: { id: true, name: true, priceCents: true, durationMin: true, category: true, active: true, components: true },
          })
        : Promise.resolve([]),
      userId ? tx.user.findFirst({ where: { id: userId }, select: { post: true } }) : Promise.resolve(null),
    ]),
  );
  const items = new Map<string, CartaItemLike>(rows.map((r) => [r.id, r]));
  const result = resolveChargeLines({
    lines: input.lines,
    serviceItemId: input.serviceItemId,
    amountCents: input.amountCents,
    requestedCategory: input.requestedCategory,
    puesto: user?.post ?? null,
    role: input.role,
    items,
  });
  if (result.ok) return result.charge;
  const message = CHARGE_LINES_ERRORS[result.reason];
  throw result.reason === 'item-missing' ? new NotFoundException(message) : new BadRequestException(message);
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
