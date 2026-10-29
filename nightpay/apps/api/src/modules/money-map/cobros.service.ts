import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@nightpay/db';
import {
  PaymentStatusSchema,
  type CobroRow,
  type CobrosPage,
  type CobrosQuery,
  type InvitationSummary,
  type PaymentStatus,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { LATE_CARD_APPROVAL_EVENTS } from '../payments/late-card-approval';
import { normalizeWalletCode } from '../wallets/wallet-rules';
import {
  decodeCursor,
  mergePage,
  paymentCobroRow,
  saldoCobroRow,
  type FeedCursor,
  type PersonLike,
} from './cobros-rows';
import { invitationTotals } from './invitation-totals';

const PERSON_SELECT_FOR_LINES = { id: true, displayName: true, email: true, role: true } as const;
const LINE_SELECT = {
  category: true,
  label: true,
  qty: true,
  unitCents: true,
  amountCents: true,
  serviceItemId: true,
  beneficiary: { select: PERSON_SELECT_FOR_LINES },
} as const;
const LINE_ORDER = [{ createdAt: 'asc' as const }, { amountCents: 'desc' as const }, { id: 'asc' as const }];
const PERSON_SELECT = { id: true, displayName: true, email: true, role: true } as const;
/** Cobros que encuentra el buscador como mucho (los más recientes): un código de 3 se repite con los meses. */
const SEARCH_MAX_MATCHES = 500;

/**
 * Cobro único pagado con el saldo: el cobro con tarjeta se canceló solo
 * (cobro-link.cancelCardForSaldo) y no es otro cobro: su fila es la del saldo,
 * con la misma referencia. Sale solo si el banco aprobó la tarjeta después
 * (cobrado dos veces: marcado, y en Incidencias si hay que devolverlo).
 */
export const NOT_SALDO_TWIN: Prisma.PaymentWhereInput = {
  NOT: {
    status: 'CANCELED',
    linkedWalletCharge: { is: { status: 'ACCEPTED' } },
    events: { none: { eventType: { in: LATE_CARD_APPROVAL_EVENTS } } },
  },
};

/** Los cobros con tarjeta ya cobrados (o devueltos) que cuentan como «pagado» en el filtro de estado. */
const SALDO_STATUSES_FOR = (status: readonly string[] | undefined): { accepted: boolean; reversed: boolean } => {
  if (!status || status.length === 0) return { accepted: true, reversed: true };
  return { accepted: status.includes('AUTHORIZED') || status.includes('ACCEPTED'), reversed: status.includes('REFUNDED') || status.includes('REVERSED') };
};

interface Scope {
  /** Local de la lista (los cobros y cobros del saldo hechos en él). */
  tenantId: string;
  /** Saldos que se buscan (por su código o su id). Null = todos. */
  walletIds: string[] | null;
  searchIds: string[] | null;
  from: Date | null;
  to: Date | null;
}

/**
 * La lista de cobros del panel (Cobros, la ficha de la chica y la del saldo):
 * los cobros con tarjeta (y las recargas) y los cobros del saldo del local,
 * juntos y por fecha, con filtros por chica, sección, cómo pagó, saldo y
 * noche. payment_lines, client_wallets y wallet_consumptions tienen FORCE
 * RLS: todo dentro de una transacción (asSystem, con el filtro del local del
 * middleware y, además, a mano).
 */
@Injectable()
export class CobrosService {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /**
   * Las invitaciones a una chica (su ficha): copas con invitación cobradas
   * (sin las devueltas del todo ni los consumos anulados), lo vendido y su
   * parte (menos lo descontado por las devueltas en parte).
   */
  async invitationSummary(tenantId: string, operatorId: string): Promise<InvitationSummary> {
    return this.prisma.withTenant(tenantId, (tx) => invitationTotals(tx, tenantId, operatorId));
  }

  async list(tenantId: string, q: CobrosQuery): Promise<CobrosPage> {
    const cursor = decodeCursor(q.cursor);
    return this.prisma.asSystem(async (tx) => {
      const scope = await this.scopeOf(tx, tenantId, q);
      if (!scope) return { items: [], nextCursor: null };
      const wantPayments = q.method !== 'SALDO' && q.method !== 'CASH';
      const wantSaldo = q.method === undefined || q.method === 'SALDO';
      const [payments, saldo] = await Promise.all([
        wantPayments ? this.paymentRows(tx, scope, q, cursor) : Promise.resolve([]),
        wantSaldo ? this.saldoRows(tx, scope, q, cursor) : Promise.resolve([]),
      ]);
      return mergePage([...payments, ...saldo], q.limit);
    });
  }

  /** Saldo por su código (K7Q-4M2) o su id, y la noche → fechas. Null = no hay nada que enseñar. */
  private async scopeOf(tx: TransactionalClient, tenantId: string, q: CobrosQuery): Promise<Scope | null> {
    let walletIds: string[] | null = null;
    if (q.walletId) walletIds = [q.walletId];
    if (q.walletCode) {
      const code = normalizeWalletCode(q.walletCode);
      const found = await tx.clientWallet.findMany({ where: { shortCode: code }, select: { id: true }, take: 20 });
      walletIds = [...(walletIds ?? []), ...found.map((w) => w.id)];
      if (walletIds.length === 0) return null;
    }
    let searchIds: string[] | null = null;
    if (q.search) {
      // También se busca fuera de la página cargada; el local se limita en SQL.
      const term = q.search.toLowerCase();
      const matches = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT p.id FROM payments p
        LEFT JOIN LATERAL (
          SELECT pa."providerTxId" FROM payment_attempts pa
          WHERE pa."paymentId" = p.id AND pa.status = 'APPROVED'
          ORDER BY pa."createdAt" ASC LIMIT 1
        ) a ON true
        WHERE p."tenantId" = ${tenantId}::uuid AND (
          lower(right(p.id::text, 3)) = ${term}
          OR position(${term} in lower(COALESCE(a."providerTxId", p."providerTxId", p."posOperationNumber", ''))) > 0
          OR position(${term} in lower(COALESCE(p."authCode", ''))) > 0
        )
        ORDER BY p."createdAt" DESC
        LIMIT ${SEARCH_MAX_MATCHES}
      `;
      searchIds = matches.map((p) => p.id);
      if (searchIds.length === 0) return null;
    }
    let night: { openedAt: Date; closedAt: Date | null } | null = null;
    if (q.nightId) {
      night = await tx.venueNight.findFirst({ where: { id: q.nightId, tenantId }, select: { openedAt: true, closedAt: true } });
      if (!night) throw new NotFoundException('Esa noche no es de este local');
    }
    const window = cobrosWindow(night, q);
    if (!window) return null;
    return { tenantId, walletIds, searchIds, ...window };
  }

  private async paymentRows(
    tx: TransactionalClient,
    scope: Scope,
    q: CobrosQuery,
    cursor: FeedCursor | null,
  ): Promise<CobroRow[]> {
    const and: Prisma.PaymentWhereInput[] = [{ tenantId: scope.tenantId }, NOT_SALDO_TWIN];
    const statuses = paymentStatuses(q.status);
    if (statuses) and.push({ status: { in: statuses } });
    if (q.operatorId) and.push({ createdByUserId: q.operatorId });
    if (scope.walletIds) and.push({ walletId: { in: scope.walletIds } });
    if (scope.searchIds) and.push({ id: { in: scope.searchIds } });
    const dates = dateWhere(scope, cursor);
    if (dates) and.push(dates);
    if (q.category) and.push(paymentCategoryWhere(q.category));
    if (q.method) and.push(paymentMethodWhere(q.method));
    if (q.invitedOperatorId) and.push({ lines: { some: { beneficiaryOperatorId: q.invitedOperatorId } } });
    const rows = await tx.payment.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      select: {
        id: true,
        ref: true,
        createdAt: true,
        updatedAt: true,
        amountCents: true,
        tipCents: true,
        serviceFeeCents: true,
        availableAmountCents: true,
        currency: true,
        status: true,
        provider: true,
        providerTxId: true,
        captureMethod: true,
        revenueCategory: true,
        serviceName: true,
        walletId: true,
        posOperationNumber: true,
        authCode: true,
        cardLast4: true,
        cardBrand: true,
        payMethodCode: true,
        authorizedAt: true,
        attempts: {
          select: { providerTxId: true, status: true, createdAt: true, amountCents: true, tipCents: true, payMethod: true },
          orderBy: { createdAt: 'asc' },
        },
        terminal: { select: { externalId: true, label: true } },
        createdBy: { select: PERSON_SELECT },
        wallet: { select: { id: true, shortCode: true } },
        lines: { select: LINE_SELECT, orderBy: LINE_ORDER },
        events: {
          where: { eventType: { in: LATE_CARD_APPROVAL_EVENTS } },
          select: { eventType: true, payload: true },
        },
      },
    });
    return rows.map((p) => paymentCobroRow(p));
  }

  private async saldoRows(
    tx: TransactionalClient,
    scope: Scope,
    q: CobrosQuery,
    cursor: FeedCursor | null,
  ): Promise<CobroRow[]> {
    const wanted = SALDO_STATUSES_FOR(q.status);
    if (!wanted.accepted && !wanted.reversed) return [];
    const and: Prisma.WalletChargeRequestWhereInput[] = [{ tenantId: scope.tenantId }];
    if (scope.searchIds) and.push({ linkedPaymentId: { in: scope.searchIds } });
    if (q.operatorId) and.push({ requestedByUserId: q.operatorId });
    if (scope.walletIds) and.push({ walletId: { in: scope.walletIds } });
    const dates = dateWhere(scope, cursor);
    if (dates) and.push(dates);
    if (q.category) and.push(saldoCategoryWhere(q.category));
    if (q.invitedOperatorId) and.push({ lines: { some: { beneficiaryOperatorId: q.invitedOperatorId } } });
    const rows = await saldoCharges(tx, { AND: and }, q.limit + 1);
    return rows.filter((r) => (r.status === 'REVERSED' ? wanted.reversed : wanted.accepted));
  }
}

/**
 * Cobros del saldo pagados que cumplen `where`, más nuevos primero, como filas
 * de la lista (con quién cobró, su saldo y si se anuló el consumo). Dentro de
 * una transacción: client_wallets y wallet_consumptions tienen FORCE RLS.
 */
export async function saldoCharges(
  tx: TransactionalClient,
  where: Prisma.WalletChargeRequestWhereInput,
  take: number,
): Promise<Array<CobroRow & { tenantId: string }>> {
  const rows = await tx.walletChargeRequest.findMany({
    where: { AND: [where, { status: 'ACCEPTED', consumptionId: { not: null } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: {
      id: true,
      tenantId: true,
      ref: true,
      createdAt: true,
      amountCents: true,
      category: true,
      serviceName: true,
      status: true,
      requestedByUserId: true,
      consumptionId: true,
      linkedPaymentId: true,
      wallet: { select: { id: true, shortCode: true } },
      lines: { select: LINE_SELECT, orderBy: LINE_ORDER },
    },
  });
  const [people, consumptions] = await Promise.all([
    peopleById(tx, rows.map((r) => r.requestedByUserId)),
    tx.walletConsumption.findMany({
      where: { id: { in: rows.flatMap((r) => (r.consumptionId ? [r.consumptionId] : [])) } },
      select: { id: true, reversedAt: true, tipCents: true, authMethod: true },
    }),
  ]);
  const byId = new Map(consumptions.map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = r.consumptionId ? byId.get(r.consumptionId) : undefined;
    const row = saldoCobroRow({
      ...r,
      person: people.get(r.requestedByUserId) ?? null,
      reversed: Boolean(c?.reversedAt),
      tipCents: c?.tipCents ?? 0,
      authMethod: c?.authMethod ?? null,
    });
    return { ...row, tenantId: r.tenantId };
  });
}

/** Personas por id (quién cobró). */
export async function peopleById(tx: TransactionalClient, ids: string[]): Promise<Map<string, PersonLike>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: PERSON_SELECT });
  return new Map(rows.map((u) => [u.id, u]));
}

/** Noche y página: (fecha, id) más antiguos que el último de la página anterior. */
/**
 * Las fechas de la lista: las de la noche y/o las de `from`/`to` (la ventana
 * de una cifra del mapa del dinero), la parte común. Null = no se solapan.
 */
export function cobrosWindow(
  night: { openedAt: Date; closedAt: Date | null } | null,
  q: Pick<CobrosQuery, 'from' | 'to'>,
): { from: Date | null; to: Date | null } | null {
  const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
  const earliest = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b));
  const from = latest(night?.openedAt ?? null, q.from ? new Date(q.from) : null);
  const to = earliest(night?.closedAt ?? null, q.to ? new Date(q.to) : null);
  return from && to && from >= to ? null : { from, to };
}

function dateWhere(scope: Scope, cursor: FeedCursor | null): { AND: Array<Record<string, unknown>> } | null {
  const and: Array<Record<string, unknown>> = [];
  if (scope.from) and.push({ createdAt: { gte: scope.from } });
  if (scope.to) and.push({ createdAt: { lt: scope.to } });
  if (cursor) {
    // La base guarda microsegundos y JavaScript milisegundos: el mismo
    // milisegundo del último se desempata por id (como lo ordena la página).
    const nextMs = new Date(cursor.at.getTime() + 1);
    and.push({ OR: [{ createdAt: { lt: cursor.at } }, { createdAt: { gte: cursor.at, lt: nextMs }, id: { lt: cursor.id } }] });
  }
  return and.length > 0 ? { AND: and } : null;
}

/** Cobros con alguna línea en esa sección (los antiguos, por su categoría; las recargas nunca). */
function paymentCategoryWhere(category: string): Prisma.PaymentWhereInput {
  const legacy: Prisma.PaymentWhereInput = { lines: { none: {} }, revenueCategory: category, walletId: null };
  if (category === 'EXTRA') return legacy;
  return { OR: [{ lines: { some: { category } } }, legacy] };
}

function saldoCategoryWhere(category: string): Prisma.WalletChargeRequestWhereInput {
  const legacy: Prisma.WalletChargeRequestWhereInput = { lines: { none: {} }, category };
  if (category === 'EXTRA') return legacy;
  return { OR: [{ lines: { some: { category } } }, legacy] };
}

/** Cómo pagó: datáfono, Apple Pay / Google Pay o tarjeta (el resto). Sin NOT: los NULL de SQL no cuentan. */
function paymentMethodWhere(method: string): Prisma.PaymentWhereInput {
  if (method === 'POS') return { OR: [{ captureMethod: 'POS_EXTERNAL' }, { posOperationNumber: { not: null } }] };
  const notPos: Prisma.PaymentWhereInput = {
    AND: [{ OR: [{ captureMethod: null }, { captureMethod: { not: 'POS_EXTERNAL' } }] }, { posOperationNumber: null }],
  };
  const mobile = { status: 'APPROVED', payMethod: 'wallet' };
  if (method === 'MOBILE_WALLET') return { AND: [notPos, { attempts: { some: mobile } }] };
  return { AND: [notPos, { attempts: { none: mobile } }] };
}

/** Los estados del filtro que existen (uno inventado no rompe la consulta). Null = todos. */
function paymentStatuses(status: readonly string[] | undefined): PaymentStatus[] | null {
  if (!status || status.length === 0) return null;
  return status.flatMap((s) => (PaymentStatusSchema.safeParse(s).success ? [s as PaymentStatus] : []));
}
