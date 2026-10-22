import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Role } from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { madridDay, madridStartOfDay, nextDay } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { BankFileError, parseBankFile } from './bank-file';
import {
  PROBLEM_STATUSES,
  reconcile,
  referenceKey,
  sameTerminal,
  type BankRow,
  type BankSource,
  type ItemStatus,
  type OurRefund,
  type OurSale,
  type ReconItem,
  type StrayPayment,
} from './bank-match';

type Actor = { userId: string; role: Role; tenantId: string };

/** Lo que cuenta como cobrado aquí. */
const PAID_STATUSES = ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
/** El portal de Redsys deja consultar 31 días; con margen. */
const MAX_PERIOD_DAYS = 62;
/** Fichero exportado a media tarde: lo cobrado después aún no puede estar. */
const SAME_DAY_GRACE_MS = 10 * 60_000;
/** Lo de aquí se carga con este margen para casar cobros en el borde de los días. */
const EDGE_SLACK_MS = 60 * 60_000;

export interface StatementSummary {
  id: string;
  source: BankSource;
  fileName: string;
  periodFrom: string;
  periodTo: string;
  rowsTotal: number;
  /** Operaciones que no se pudieron leer. */
  skippedCount: number;
  /** Operaciones de otro tipo (preautorizaciones…) que no entran en el cuadre. */
  otherCount: number;
  matchedCount: number;
  problemCount: number;
  bankTotalCents: number;
  oursTotalCents: number;
  superseded: boolean;
  createdAt: string;
}

export interface StatementItemView {
  id: string;
  status: ItemStatus;
  kind: 'SALE' | 'REFUND';
  line: number | null;
  occurredAt: string | null;
  bankAmountCents: number | null;
  oursAmountCents: number | null;
  reference: string | null;
  authCode: string | null;
  paymentId: string | null;
  venueName: string | null;
  superseded: boolean;
}

export interface ImportInput {
  source: BankSource;
  fileName: string;
  content: Buffer;
  periodFrom?: string;
  periodTo?: string;
}

/**
 * Cuadre con el banco. El dueño sube el fichero de operaciones del portal
 * (Canales de Redsys o Paytef) y se compara con lo apuntado en los locales
 * de su grupo (mismo comercio en el banco). Lo que no cuadra sale en
 * Incidencias; un fichero posterior que cubra los mismos días lo sustituye.
 */
@Injectable()
export class BankReconService {
  private readonly logger = new Logger(BankReconService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(AuditService) audit: AuditService) {
    this.prisma = prisma;
    this.audit = audit;
  }

  async importStatement(actor: Actor, input: ImportInput, now: Date = new Date()): Promise<StatementSummary> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('El cuadre con el banco lo hace el dueño');
    let parsed;
    try {
      parsed = parseBankFile(input.source, input.content);
    } catch (err) {
      if (err instanceof BankFileError) throw new BadRequestException(err.message);
      throw err;
    }
    const periodFrom = input.periodFrom ?? parsed.periodFrom;
    const periodTo = input.periodTo ?? parsed.periodTo;
    if (!periodFrom || !periodTo) {
      throw new BadRequestException('El fichero no trae fechas: indica los días que cubre');
    }
    if (periodFrom > periodTo) throw new BadRequestException('El primer día va después del último');
    if (daysBetween(periodFrom, periodTo) > MAX_PERIOD_DAYS) {
      throw new BadRequestException(`Sube como mucho ${MAX_PERIOD_DAYS} días por fichero`);
    }

    const venueIds = await this.groupVenueIds(actor.tenantId);
    const from = madridStartOfDay(periodFrom);
    let to = madridStartOfDay(nextDay(periodTo));
    // Exportado hoy mismo: lo cobrado después de la última operación del fichero aún no puede estar.
    if (periodTo >= madridDay(now)) {
      const last = Math.max(...parsed.rows.filter((r) => r.at).map((r) => r.at!.getTime()), from.getTime());
      to = new Date(Math.min(to.getTime(), last + SAME_DAY_GRACE_MS));
    }

    const loadFrom = new Date(from.getTime() - EDGE_SLACK_MS);
    const loadTo = new Date(to.getTime() + EDGE_SLACK_MS);
    const ours = await this.prisma.acrossVenues((tx) =>
      input.source === 'REDSYS'
        ? loadRedsys(tx, venueIds, loadFrom, loadTo, parsed.rows)
        : loadPaytef(tx, venueIds, loadFrom, loadTo, parsed.rows),
    );
    const result = reconcile({ rows: parsed.rows, ...ours, window: { from, to } });
    const otherCount = parsed.rows.filter((r) => r.approved && r.kind === 'OTHER').length;
    const terminalVenue = await this.terminalVenues(venueIds, parsed.rows);
    const problems = result.items.filter((i) => PROBLEM_STATUSES.has(i.status)).length;
    const fileSha256 = createHash('sha256').update(input.content).digest('hex');

    const statement = await this.prisma.acrossVenues(async (tx) => {
      // Lo que ya se había cuadrado de esos días deja de contar.
      const older = await tx.bankStatement.findMany({
        where: {
          tenantId: { in: venueIds },
          source: input.source,
          periodFrom: { lte: dateOnly(periodTo) },
          periodTo: { gte: dateOnly(periodFrom) },
          supersededAt: null,
        },
        select: { id: true, periodFrom: true, periodTo: true },
      });
      if (older.length > 0) {
        const covered = older.filter(
          (o) => isoDay(o.periodFrom) >= periodFrom && isoDay(o.periodTo) <= periodTo,
        );
        // Solo lo que este fichero vuelve a cuadrar: sus horas (no más allá de su
        // última operación si se exportó hoy), y lo sin hora de cuadres que cubre enteros.
        await tx.bankStatementItem.updateMany({
          where: {
            statementId: { in: older.map((o) => o.id) },
            supersededAt: null,
            OR: [
              { occurredAt: { gte: from, lt: to } },
              { occurredAt: null, statementId: { in: covered.map((o) => o.id) } },
            ],
          },
          data: { supersededAt: now },
        });
        if (covered.length > 0) {
          await tx.bankStatement.updateMany({
            where: { id: { in: covered.map((o) => o.id) } },
            data: { supersededAt: now },
          });
        }
      }
      const created = await tx.bankStatement.create({
        data: {
          tenantId: actor.tenantId,
          source: input.source,
          fileName: input.fileName.slice(0, 200),
          fileSha256,
          periodFrom: dateOnly(periodFrom),
          periodTo: dateOnly(periodTo),
          rowsTotal: parsed.rows.length,
          skippedCount: parsed.skipped,
          otherCount,
          matchedCount: result.items.length - problems,
          problemCount: problems,
          bankTotalCents: result.bankTotalCents,
          oursTotalCents: result.oursTotalCents,
          uploadedByUserId: actor.userId,
        },
      });
      if (result.items.length > 0) {
        await tx.bankStatementItem.createMany({
          data: result.items.map((item) => itemRow(created.id, item, actor.tenantId, terminalVenue)),
        });
      }
      return created;
    });

    await this.audit.log({
      action: 'bank_statement.imported',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'BankStatement',
      targetId: statement.id,
      payload: {
        source: input.source,
        periodFrom,
        periodTo,
        rows: parsed.rows.length,
        skipped: parsed.skipped,
        other: otherCount,
        problems,
        fileSha256,
      },
    });
    this.logger.log(
      `Cuadre ${input.source} ${periodFrom}..${periodTo}: ${parsed.rows.length} líneas, ${problems} diferencias`,
    );
    return summary(statement);
  }

  async list(actor: Actor): Promise<StatementSummary[]> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('El cuadre con el banco lo ve el dueño');
    const venueIds = await this.groupVenueIds(actor.tenantId);
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.bankStatement.findMany({
        where: { tenantId: { in: venueIds } },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    );
    return rows.map(summary);
  }

  async detail(actor: Actor, statementId: string): Promise<{ statement: StatementSummary; items: StatementItemView[] }> {
    if (actor.role !== 'OWNER') throw new ForbiddenException('El cuadre con el banco lo ve el dueño');
    const venueIds = await this.groupVenueIds(actor.tenantId);
    const statement = await this.prisma.acrossVenues((tx) =>
      tx.bankStatement.findFirst({ where: { id: statementId, tenantId: { in: venueIds } } }),
    );
    if (!statement) throw new NotFoundException('Cuadre no encontrado');
    const [items, venues] = await Promise.all([
      this.prisma.acrossVenues((tx) =>
        tx.bankStatementItem.findMany({ where: { statementId }, orderBy: [{ occurredAt: 'asc' }, { line: 'asc' }] }),
      ),
      this.prisma.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } }),
    ]);
    const venueName = new Map(venues.map((v) => [v.id, v.name]));
    const views = items.map<StatementItemView>((i) => ({
      id: i.id,
      status: i.status as ItemStatus,
      kind: i.kind as 'SALE' | 'REFUND',
      line: i.line,
      occurredAt: i.occurredAt?.toISOString() ?? null,
      bankAmountCents: i.bankAmountCents,
      oursAmountCents: i.oursAmountCents,
      reference: i.reference,
      authCode: i.authCode,
      paymentId: i.paymentId,
      venueName: venueName.get(i.tenantId) ?? null,
      superseded: i.supersededAt !== null,
    }));
    // Lo que no cuadra, primero.
    views.sort((a, b) => Number(!PROBLEM_STATUSES.has(a.status)) - Number(!PROBLEM_STATUSES.has(b.status)));
    return { statement: summary(statement), items: views };
  }

  /** Locales del mismo grupo (mismo dueño y comercio en el banco). */
  private async groupVenueIds(venueId: string): Promise<string[]> {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } });
    if (!venue?.walletGroup) return [venueId];
    const venues = await this.prisma.venue.findMany({ where: { walletGroup: venue.walletGroup }, select: { id: true } });
    return venues.map((v) => v.id);
  }

  /** Datáfono del fichero → su local (por identificador o número de serie). */
  private async terminalVenues(venueIds: string[], rows: BankRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.terminal?.trim()).filter((t): t is string => Boolean(t)))];
    if (ids.length === 0) return new Map();
    const terminals = await this.prisma.acrossVenues((tx) =>
      tx.terminal.findMany({
        where: { tenantId: { in: venueIds }, OR: [{ externalId: { in: ids } }, { deviceSerial: { in: ids } }] },
        select: { tenantId: true, externalId: true, deviceSerial: true },
      }),
    );
    const map = new Map<string, string>();
    for (const t of terminals) {
      map.set(t.externalId, t.tenantId);
      if (t.deviceSerial) map.set(t.deviceSerial, t.tenantId);
    }
    return map;
  }
}

// ─── Lo apuntado aquí, por pasarela ─────────────────────────────────────

interface OurSide {
  sales: OurSale[];
  refunds: OurRefund[];
  strays: StrayPayment[];
  /** Nombres de datáfono del fichero que son de los nuestros (solo Paytef). */
  knownTerminals?: ReadonlySet<string>;
}

/** Referencias por consulta al buscar cobros sin pagar (cada una va con sus variantes). */
const STRAY_REFS_PER_QUERY = 2_000;

async function loadRedsys(
  tx: TransactionalClient,
  venueIds: string[],
  from: Date,
  to: Date,
  rows: BankRow[],
): Promise<OurSide> {
  const payments = await tx.payment.findMany({
    where: {
      tenantId: { in: venueIds },
      provider: 'REDSYS',
      status: { in: [...PAID_STATUSES] },
      authorizedAt: { gte: from, lt: to },
    },
    select: {
      id: true,
      tenantId: true,
      amountCents: true,
      tipCents: true,
      authCode: true,
      authorizedAt: true,
      providerTxId: true,
      attempts: { where: { status: 'APPROVED' }, select: { providerTxId: true, amountCents: true } },
    },
  });
  const sales = payments.map<OurSale>((p) => ({
    paymentId: p.id,
    tenantId: p.tenantId,
    references: uniq([...p.attempts.map((a) => a.providerTxId), p.providerTxId]),
    terminal: null,
    authCode: p.authCode,
    amountCents: p.attempts[0]?.amountCents ?? p.amountCents + p.tipCents,
    at: p.authorizedAt!,
  }));

  const refunds = await tx.refund.findMany({
    where: {
      tenantId: { in: venueIds },
      status: 'SUCCEEDED',
      payment: { provider: 'REDSYS' },
      OR: [
        { bankRefundedAt: { gte: from, lt: to } },
        { bankRefundedAt: null, createdAt: { gte: from, lt: to } },
      ],
    },
    select: {
      id: true,
      paymentId: true,
      tenantId: true,
      amountCents: true,
      bankRefundedAt: true,
      createdAt: true,
      payment: { select: { providerTxId: true, attempts: { where: { status: 'APPROVED' }, select: { providerTxId: true } } } },
    },
  });

  // Pedidos que el banco cobró y aquí no están entre los pagados (aviso perdido, cobro sin cerrar…).
  const paidRefs = new Set(sales.flatMap((s) => s.references.map(referenceKey)));
  const unmatchedRefs = uniq(
    rows
      .filter((r) => r.approved && r.kind === 'SALE' && r.reference && !paidRefs.has(referenceKey(r.reference)))
      .map((r) => r.reference!.trim()),
  );
  const strayAttempts =
    unmatchedRefs.length === 0
      ? []
      : await tx.paymentAttempt.findMany({
          where: { provider: 'REDSYS', providerTxId: { in: referenceVariants(unmatchedRefs) }, tenantId: { in: venueIds } },
          select: {
            providerTxId: true,
            amountCents: true,
            payment: { select: { id: true, tenantId: true, status: true, amountCents: true, tipCents: true } },
          },
        });

  return {
    sales,
    refunds: refunds.map<OurRefund>((r) => ({
      refundId: r.id,
      paymentId: r.paymentId,
      tenantId: r.tenantId,
      paymentReferences: uniq([...r.payment.attempts.map((a) => a.providerTxId), r.payment.providerTxId]),
      amountCents: r.amountCents,
      at: r.bankRefundedAt ?? r.createdAt,
    })),
    strays: strayAttempts
      .filter((a) => !PAID_STATUSES.includes(a.payment.status as (typeof PAID_STATUSES)[number]))
      .map<StrayPayment>((a) => ({
        paymentId: a.payment.id,
        tenantId: a.payment.tenantId,
        references: [a.providerTxId],
        amountCents: a.amountCents ?? a.payment.amountCents + a.payment.tipCents,
      })),
  };
}

async function loadPaytef(
  tx: TransactionalClient,
  venueIds: string[],
  from: Date,
  to: Date,
  rows: BankRow[],
): Promise<OurSide> {
  // Un número de operación solo es único dentro de su datáfono: lo nuestro se
  // nombra como lo nombra el fichero (identificador o número de serie).
  const terminalName = await fileTerminalNames(tx, venueIds, rows);
  const knownTerminals = new Set(terminalName.values());
  const terminalOf = (id: string | null) => (id ? (terminalName.get(id) ?? null) : null);
  const datafono = {
    OR: [
      { posOperationNumber: { not: null } },
      { provider: 'PAYTEF' as const },
      { captureMethod: 'POS_EXTERNAL' },
    ],
  };
  const payments = await tx.payment.findMany({
    where: {
      tenantId: { in: venueIds },
      status: { in: [...PAID_STATUSES] },
      authorizedAt: { gte: from, lt: to },
      ...datafono,
    },
    select: {
      id: true,
      tenantId: true,
      amountCents: true,
      tipCents: true,
      authCode: true,
      authorizedAt: true,
      posOperationNumber: true,
      posTerminalId: true,
    },
  });
  const sales = payments.map<OurSale>((p) => ({
    paymentId: p.id,
    tenantId: p.tenantId,
    references: p.posOperationNumber ? [p.posOperationNumber] : [],
    terminal: terminalOf(p.posTerminalId),
    authCode: p.authCode,
    amountCents: p.amountCents + p.tipCents,
    at: p.authorizedAt!,
  }));

  const refunds = await tx.refund.findMany({
    where: {
      tenantId: { in: venueIds },
      status: 'SUCCEEDED',
      payment: datafono,
      OR: [
        { bankRefundedAt: { gte: from, lt: to } },
        { bankRefundedAt: null, createdAt: { gte: from, lt: to } },
      ],
    },
    select: {
      id: true,
      paymentId: true,
      tenantId: true,
      amountCents: true,
      bankRefundedAt: true,
      createdAt: true,
      payment: { select: { posOperationNumber: true, posTerminalId: true } },
    },
  });

  // Operaciones que el banco cobró y aquí no casan con un cobro pagado de su
  // datáfono: se buscan entre los no pagados (también las de un datáfono que
  // no sabemos cuál es, para no elegir el pagado si hay otro igual sin pagar).
  const strayPayments = await findStrayPayments(tx, venueIds, unmatchedReferences(rows, sales, knownTerminals));

  return {
    sales,
    knownTerminals,
    refunds: refunds.map<OurRefund>((r) => ({
      refundId: r.id,
      paymentId: r.paymentId,
      tenantId: r.tenantId,
      paymentReferences: r.payment.posOperationNumber ? [r.payment.posOperationNumber] : [],
      terminal: terminalOf(r.payment.posTerminalId),
      amountCents: r.amountCents,
      at: r.bankRefundedAt ?? r.createdAt,
    })),
    strays: strayPayments.map<StrayPayment>((p) => ({
      paymentId: p.id,
      tenantId: p.tenantId,
      references: p.posOperationNumber ? [p.posOperationNumber] : [],
      terminal: terminalOf(p.posTerminalId),
      amountCents: p.amountCents + p.tipCents,
    })),
  };
}

/**
 * Nuestros datáfonos del grupo → el nombre con el que salen en el fichero (su
 * identificador o, si no, su número de serie). Los que no salen no están.
 */
async function fileTerminalNames(tx: TransactionalClient, venueIds: string[], rows: BankRow[]): Promise<Map<string, string>> {
  const inFile = new Set(rows.map((r) => r.terminal?.trim()).filter((t): t is string => Boolean(t)));
  const names = new Map<string, string>();
  if (inFile.size === 0) return names;
  const terminals = await tx.terminal.findMany({
    where: { tenantId: { in: venueIds } },
    select: { id: true, externalId: true, deviceSerial: true },
  });
  for (const t of terminals) {
    const name = [t.externalId, t.deviceSerial].map((n) => n?.trim()).find((n): n is string => Boolean(n && inFile.has(n)));
    if (name) names.set(t.id, name);
  }
  return names;
}

/** Referencias de ventas del banco sin un cobro pagado de su datáfono que las case. */
function unmatchedReferences(rows: BankRow[], sales: OurSale[], known: ReadonlySet<string>): string[] {
  const salesByRef = new Map<string, OurSale[]>();
  for (const sale of sales) {
    for (const ref of sale.references) salesByRef.set(referenceKey(ref), [...(salesByRef.get(referenceKey(ref)) ?? []), sale]);
  }
  return uniq(
    rows
      .filter((r) => r.approved && r.kind === 'SALE' && r.reference)
      .filter((r) => {
        const bankTerminal = r.terminal?.trim();
        // Sin datáfono conocido en la línea, puede ser de otro con el mismo número.
        if (!bankTerminal || !known.has(bankTerminal)) return true;
        return !(salesByRef.get(referenceKey(r.reference!)) ?? []).some((s) => sameTerminal(r, s, known));
      })
      .map((r) => r.reference!.trim()),
  );
}

async function findStrayPayments(tx: TransactionalClient, venueIds: string[], refs: string[]) {
  const found = [];
  for (let i = 0; i < refs.length; i += STRAY_REFS_PER_QUERY) {
    found.push(
      ...(await tx.payment.findMany({
        where: {
          tenantId: { in: venueIds },
          posOperationNumber: { in: referenceVariants(refs.slice(i, i + STRAY_REFS_PER_QUERY)) },
          status: { notIn: [...PAID_STATUSES] },
        },
        select: { id: true, tenantId: true, amountCents: true, tipCents: true, posOperationNumber: true, posTerminalId: true },
      })),
    );
  }
  return found;
}

// ─── Auxiliares ─────────────────────────────────────────────────────────

function itemRow(statementId: string, item: ReconItem, uploaderVenue: string, terminalVenue: Map<string, string>) {
  const fromTerminal = item.terminal ? terminalVenue.get(item.terminal.trim()) : undefined;
  return {
    statementId,
    tenantId: item.tenantId ?? fromTerminal ?? uploaderVenue,
    status: item.status,
    kind: item.kind,
    line: item.line,
    occurredAt: item.at,
    bankAmountCents: item.bankAmountCents,
    oursAmountCents: item.oursAmountCents,
    reference: item.reference?.slice(0, 64) ?? null,
    terminal: item.terminal?.slice(0, 64) ?? null,
    authCode: item.authCode?.slice(0, 16) ?? null,
    paymentId: item.paymentId,
    refundId: item.refundId,
  };
}

function summary(s: {
  id: string;
  source: string;
  fileName: string;
  periodFrom: Date;
  periodTo: Date;
  rowsTotal: number;
  skippedCount: number;
  otherCount: number;
  matchedCount: number;
  problemCount: number;
  bankTotalCents: number;
  oursTotalCents: number;
  supersededAt: Date | null;
  createdAt: Date;
}): StatementSummary {
  return {
    id: s.id,
    source: s.source as BankSource,
    fileName: s.fileName,
    periodFrom: isoDay(s.periodFrom),
    periodTo: isoDay(s.periodTo),
    rowsTotal: s.rowsTotal,
    skippedCount: s.skippedCount,
    otherCount: s.otherCount,
    matchedCount: s.matchedCount,
    problemCount: s.problemCount,
    bankTotalCents: s.bankTotalCents,
    oursTotalCents: s.oursTotalCents,
    superseded: s.supersededAt !== null,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Columna DATE: "AAAA-MM-DD" → medianoche UTC. */
function dateOnly(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((dateOnly(b).getTime() - dateOnly(a).getTime()) / 86_400_000) + 1;
}

/**
 * Variantes de una referencia del fichero para buscarla aquí: tal cual, sin
 * ceros delante y con ellos (los pedidos de Redsys tienen 12 caracteres).
 */
export function referenceVariants(refs: string[]): string[] {
  const out = new Set<string>();
  for (const ref of refs) {
    const t = ref.trim();
    if (!t) continue;
    const bare = t.replace(/^0+/, '');
    out.add(t);
    if (bare) out.add(bare);
    if (bare && bare.length < 12) out.add(bare.padStart(12, '0'));
    if (/^\d+$/.test(bare)) for (const len of [6, 8, 10]) if (bare.length < len) out.add(bare.padStart(len, '0'));
  }
  return [...out];
}

function uniq(list: Array<string | null | undefined>): string[] {
  return [...new Set(list.filter((x): x is string => Boolean(x && x.trim())))];
}
