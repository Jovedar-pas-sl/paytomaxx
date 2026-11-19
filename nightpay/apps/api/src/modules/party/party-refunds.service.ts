import { randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
  PARTY_REFUND_ERRORS,
  isEventEnded,
  isRefundWindowOpen,
  madridDay,
  maskIban,
  pulseraLabel,
  type PartyRefundAskDto,
  type PartyRefundList,
  type PartyRefundListQuery,
  type PartyRefundMethod,
  type PartyRefundMine,
  type PartyRefundRow,
  type PartyRefundStatus,
  type PartyRefundTotals,
  type PartyRefundView,
  type Role,
} from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { EmailService } from '../../common/email/email.service';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { walletCash } from '../wallets/wallet-cash-limits';
import { formatWalletCode } from '../wallets/wallet-rules';
import { partyBrand } from './party-brand';
import { refundMail, type RefundMailKind } from './party-refund-email';
import {
  PARTY_REFUND_BLOCK_REASON,
  TOPUP_OPEN_STATUSES,
  ZERO_BY_METHOD,
  blockedByRefund,
  pendingByMethod,
  planRefundAsk,
  refundAvailability,
  walletAfterRefund,
  type RefundMoney,
  type RefundWallet,
} from './party-refund-rules';
import { transfersCsv, type TransferCsvRow } from './party-refund-csv';
import { refundTransfersSepa, type RefundSepaFile, type RefundTransfer } from './party-refund-sepa';
import { NO_DEBTOR_IBAN_CODE, NO_DEBTOR_IBAN_MESSAGE, NO_TRANSFERS_CODE } from './sepa';
import { REFUNDS_SEPA_ACTION, alreadyExported, lastRefundsExport, lockSepaExports } from './sepa-exports';

type Actor = { userId: string; role: Role; tenantId: string; email?: string };

/** Lo que la página de la pulsera (/w/:token, OxioParty) pinta ya al abrirse. */
export interface PartyPageData {
  /** La marca (BRAND_NAME o «OxioParty»). */
  brand: string;
  /** El nombre de la fiesta (el del local). */
  venueName: string;
  eventStartsAt: string | null;
  eventEndsAt: string | null;
  refund: PartyRefundView;
  /** «Casetas»: las activas, en su orden (la página las pinta; el JS no las usa). */
  stalls: PartyStallLine[];
}

/** Una caseta en la lista del asistente: sin dinero ni datos del responsable. */
export interface PartyStallLine {
  name: string;
  zone: string | null;
  sells: string | null;
  /** «Abierta ahora»; con la fiesta terminada, ninguna (ya no se puede cobrar). */
  open: boolean;
}

interface LockedWallet extends RefundWallet {
  id: string;
  tenantId: string;
}

const WALLET_SELECT = {
  id: true,
  tenantId: true,
  status: true,
  balanceCents: true,
  blockedAt: true,
  blockedReason: true,
  mergedIntoId: true,
} as const;

const REQUEST_SELECT = {
  id: true,
  tenantId: true,
  walletId: true,
  amountCents: true,
  method: true,
  iban: true,
  holderName: true,
  email: true,
  status: true,
  createdAt: true,
  doneAt: true,
  doneById: true,
} as const;

type RequestRow = Prisma.PartyRefundRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

/** Como mucho, las del panel de una vez (las más recientes primero). */
const LIST_LIMIT = 300;
/** Las suyas que ve el asistente. */
const MINE_LIMIT = 20;

/** DATE de Postgres (medianoche UTC) → AAAA-MM-DD. */
function dayOf(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function asMethod(v: string): PartyRefundMethod {
  return v === 'TRANSFER' || v === 'DONATE' ? v : 'CARD';
}

function asStatus(v: string): PartyRefundStatus {
  return v === 'DONE' || v === 'CANCELED' ? v : 'PENDING';
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ message, code });
}

/** Lo que ve el asistente de una petición (sin el IBAN entero). */
export function mineView(r: Pick<RequestRow, 'id' | 'method' | 'amountCents' | 'status' | 'createdAt' | 'doneAt' | 'iban'>): PartyRefundMine {
  return {
    id: r.id,
    method: asMethod(r.method),
    amountCents: r.amountCents,
    status: r.status === 'DONE' ? 'DONE' : 'PENDING',
    createdAt: r.createdAt.toISOString(),
    doneAt: r.doneAt?.toISOString() ?? null,
    ibanHint: maskIban(r.iban),
  };
}

/** Totales del panel, de las filas agrupadas por estado y método. */
export function refundTotals(groups: ReadonlyArray<{ status: string; method: string; count: number; cents: number }>): PartyRefundTotals {
  const zero = () => ({ CARD: { count: 0, cents: 0 }, TRANSFER: { count: 0, cents: 0 }, DONATE: { count: 0, cents: 0 } });
  const totals: PartyRefundTotals = { pending: zero(), done: zero(), canceled: { count: 0, cents: 0 }, donatedCents: 0 };
  for (const g of groups) {
    const status = asStatus(g.status);
    if (status === 'CANCELED') {
      totals.canceled.count += g.count;
      totals.canceled.cents += g.cents;
      continue;
    }
    const bucket = (status === 'DONE' ? totals.done : totals.pending)[asMethod(g.method)];
    bucket.count += g.count;
    bucket.cents += g.cents;
  }
  totals.donatedCents = totals.done.DONATE.cents;
  return totals;
}

/**
 * «Lo que sobra» (OxioParty): el asistente lo pide desde la página de su
 * pulsera y el organizador lo hace (la tarjeta, a mano en el banco; la
 * transferencia, con el CSV) y lo marca «Hecha». Donar se hace al momento.
 * Mientras hay una pendiente, el saldo está bloqueado (blockedAt con el
 * motivo de OxioParty: los pagos y las recargas ya lo respetan). Lo pedido
 * sale del saldo al hacerse. Todo en una transacción con el saldo bloqueado
 * (FOR UPDATE), siempre en el mismo orden: el saldo y después la petición.
 * client_wallets y party_refund_requests tienen FORCE RLS: asSystem, con el
 * local siempre explícito en las consultas del panel.
 */
@Injectable()
export class PartyRefundsService {
  private readonly logger = new Logger(PartyRefundsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(EmailService) private readonly mail?: EmailService,
  ) {}

  // ─── El asistente ───────────────────────────────────────────────────

  /** Lo que puede pedir ahora, por qué vía, y sus peticiones. */
  async view(walletId: string, now: Date = new Date()): Promise<PartyRefundView> {
    return this.prisma.asSystem(async (tx) => {
      const wallet = await tx.clientWallet.findUnique({ where: { id: walletId }, select: WALLET_SELECT });
      if (!wallet) throw new NotFoundException({ message: 'Saldo no encontrado', code: 'WALLET_NOT_FOUND' });
      return this.viewIn(tx, { ...wallet, status: String(wallet.status) }, now);
    });
  }

  /** Lo que la página de la pulsera pinta ya al abrirse: la fiesta, «Lo que sobra» y las casetas. */
  async pageData(walletId: string, now: Date = new Date()): Promise<PartyPageData> {
    return this.prisma.asSystem(async (tx) => {
      const wallet = await tx.clientWallet.findUnique({ where: { id: walletId }, select: WALLET_SELECT });
      if (!wallet) throw new NotFoundException({ message: 'Saldo no encontrado', code: 'WALLET_NOT_FOUND' });
      const venue = await tx.venue.findUnique({
        where: { id: wallet.tenantId },
        select: { name: true, eventStartsAt: true, eventEndsAt: true },
      });
      const ended = isEventEnded(venue?.eventEndsAt, now);
      const stalls = await tx.stall.findMany({
        where: { tenantId: wallet.tenantId, active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { name: true, zone: true, sells: true, openNow: true },
      });
      return {
        brand: partyBrand(),
        venueName: venue?.name ?? '',
        eventStartsAt: venue?.eventStartsAt?.toISOString() ?? null,
        eventEndsAt: venue?.eventEndsAt?.toISOString() ?? null,
        refund: await this.viewIn(tx, { ...wallet, status: String(wallet.status) }, now),
        stalls: stalls.map((s) => ({ name: s.name, zone: s.zone, sells: s.sells, open: s.openNow && !ended })),
      };
    });
  }

  /**
   * Pedirlo. El importe lo pone el servidor (lo que hay ahora por esa vía);
   * con `expectedAmountCents` distinto, 409 en vez de pedir otra cosa. Dos
   * toques seguidos no piden dos veces (una pendiente por vía).
   */
  async ask(walletId: string, dto: PartyRefundAskDto, now: Date = new Date()): Promise<PartyRefundView> {
    let done: { row: RequestRow; venueName: string; pulsera: string | null };
    try {
      done = await this.prisma.asSystem(async (tx) => {
        const wallet = await lockWallet(tx, walletId);
        const venue = await tx.venue.findUniqueOrThrow({
          where: { id: wallet.tenantId },
          select: { name: true, refundDeadline: true, allowDonation: true },
        });
        const { money, pendingCount } = await readMoney(tx, wallet);
        // Una devolución de OxioPay a la tarjeta a medias: primero aquella.
        if ((await tx.walletPayout.count({ where: { walletId, status: 'PENDING' } })) > 0) {
          throw conflict(PARTY_REFUND_ERRORS.nothing, 'Tu saldo tiene una devolución en marcha: pásate por la taquilla.');
        }
        // Una recarga a medias: el banco aún puede aprobarla y sumarla. Con el
        // saldo ya bloqueado, la que se apruebe ahora espera a esta transacción.
        const topUpInProgress = (await tx.payment.count({ where: { walletId, status: { in: [...TOPUP_OPEN_STATUSES] } } })) > 0;
        const plan = planRefundAsk({
          wallet,
          deadline: dayOf(venue.refundDeadline),
          allowDonation: venue.allowDonation,
          money,
          topUpInProgress,
          dto,
          now,
        });
        if (!plan.ok) throw conflict(plan.code, plan.message);
        const transfer = dto.method === 'TRANSFER';
        const row = await tx.partyRefundRequest.create({
          data: {
            tenantId: wallet.tenantId,
            walletId,
            amountCents: plan.amountCents,
            method: dto.method,
            // Del asistente, lo mínimo y solo mientras está pendiente: donar se
            // hace ya, así que su correo (para el justificante) no se guarda.
            iban: transfer ? (dto.iban ?? null) : null,
            holderName: transfer ? (dto.holderName ?? null) : null,
            email: plan.doneNow ? null : (dto.email ?? null),
            status: plan.doneNow ? 'DONE' : 'PENDING',
            ...(plan.doneNow ? { doneAt: now } : {}),
          },
          select: REQUEST_SELECT,
        });
        if (plan.doneNow) {
          // Donar: sale del saldo al momento (lo pendiente por otra vía sigue bloqueado).
          await applyRefund(tx, wallet, plan.amountCents, pendingCount);
        } else if (!wallet.blockedAt) {
          await tx.clientWallet.update({ where: { id: walletId }, data: { blockedAt: now, blockedReason: PARTY_REFUND_BLOCK_REASON } });
        }
        await this.audit.logInTx(tx, {
          action: plan.doneNow ? 'party.refund.donated' : 'party.refund.requested',
          tenantId: wallet.tenantId,
          actorId: null,
          targetType: 'PartyRefundRequest',
          targetId: row.id,
          payload: { walletId, method: dto.method, amountCents: plan.amountCents, withEmail: Boolean(dto.email) },
        });
        // El justificante va al correo que dio, aunque (donado) ya no se guarde.
        return { row: { ...row, email: dto.email ?? null }, venueName: venue.name, pulsera: await walletPulsera(tx, walletId) };
      });
    } catch (err) {
      // La misma vía pedida a la vez dos veces: la otra ya la pidió.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict(PARTY_REFUND_ERRORS.nothing, 'Ya lo has pedido: está pendiente.');
      }
      throw err;
    }
    this.sendMail(done.row.method === 'DONATE' ? 'done' : 'asked', done.row, done.venueName, done.pulsera);
    return this.view(walletId, now);
  }

  // ─── El organizador ─────────────────────────────────────────────────

  /** La lista del panel (filtrada por estado y vía) con los totales de todo. */
  async list(tenantId: string, query: PartyRefundListQuery = {}): Promise<PartyRefundList> {
    return this.prisma.asSystem(async (tx) => {
      const rows = await tx.partyRefundRequest.findMany({
        where: { tenantId, ...(query.status ? { status: query.status } : {}), ...(query.method ? { method: query.method } : {}) },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
        select: REQUEST_SELECT,
      });
      const groups = await tx.partyRefundRequest.groupBy({
        by: ['status', 'method'],
        where: { tenantId },
        _count: { _all: true },
        _sum: { amountCents: true },
      });
      const views = await rowViews(tx, rows);
      return {
        rows: views,
        totals: refundTotals(groups.map((g) => ({ status: g.status, method: g.method, count: g._count._all, cents: g._sum.amountCents ?? 0 }))),
      };
    });
  }

  /** «Hecha»: la tarjeta ya devuelta en el banco, o la transferencia ya enviada. Lo pedido sale del saldo. */
  async markDone(actor: Actor, id: string, now: Date = new Date()): Promise<PartyRefundRow> {
    const out = await this.settle(actor, id, 'DONE', now);
    this.sendMail('done', out.row, out.venueName, out.pulsera);
    return out.view;
  }

  /** Anularla (el asistente se equivocó, o la pide en la taquilla): no sale nada y el saldo vuelve a poder usarse. */
  async cancel(actor: Actor, id: string, now: Date = new Date()): Promise<PartyRefundRow> {
    return (await this.settle(actor, id, 'CANCELED', now)).view;
  }

  /** Las transferencias pendientes, en CSV para el banco (IBAN entero: solo el organizador). */
  async transfersCsv(tenantId: string): Promise<string> {
    const rows = await this.prisma.asSystem(async (tx) => {
      const pending = await tx.partyRefundRequest.findMany({
        where: { tenantId, status: 'PENDING', method: 'TRANSFER' },
        orderBy: { createdAt: 'asc' },
        select: REQUEST_SELECT,
      });
      const views = await rowViews(tx, pending);
      return pending.map<TransferCsvRow>((r, i) => ({
        id: r.id,
        createdAt: r.createdAt,
        amountCents: r.amountCents,
        iban: r.iban ?? '',
        holderName: r.holderName,
        email: r.email,
        pulsera: views[i]?.pulsera ?? null,
        walletCode: views[i]?.walletCode ?? null,
      }));
    });
    return transfersCsv(rows, partyBrand());
  }

  /**
   * El fichero SEPA (pain.001.001.03) de las transferencias pendientes con
   * IBAN, para subirlas al banco de una vez. El deudor es el local (su cuenta,
   * `settlementIban`, que pone OxioPay; sin ella, 409 NO_DEBTOR_IBAN, como el
   * cierre); sin ninguna pendiente, 409 NO_TRANSFERS. No marca nada «Hecha».
   * Cada descarga queda en el registro (`party.refunds.sepa_exported`, con
   * los ids de las peticiones). Si alguna ya iba en un fichero descargado
   * antes: 409 ALREADY_EXPORTED (cuándo y quién), salvo `again` (el panel lo
   * confirma antes): subirlo dos veces al banco paga dos veces.
   */
  async transfersSepa(actor: Actor, now: Date = new Date(), opts: { again?: boolean } = {}): Promise<RefundSepaFile> {
    const { venue, transfers } = await this.prisma.asSystem(async (tx) => {
      const venue = await tx.venue.findUniqueOrThrow({
        where: { id: actor.tenantId },
        select: { name: true, settlementIban: true, settlementHolder: true },
      });
      const pending = await tx.partyRefundRequest.findMany({
        where: { tenantId: actor.tenantId, status: 'PENDING', method: 'TRANSFER', iban: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: REQUEST_SELECT,
      });
      const views = await rowViews(tx, pending);
      const transfers = pending.map<RefundTransfer>((r, i) => ({
        id: r.id,
        amountCents: r.amountCents,
        iban: r.iban as string,
        holderName: r.holderName,
        pulsera: views[i]?.pulsera ?? null,
      }));
      return { venue, transfers };
    });
    if (!venue.settlementIban) throw new ConflictException({ code: NO_DEBTOR_IBAN_CODE, message: NO_DEBTOR_IBAN_MESSAGE });
    if (transfers.length === 0) {
      throw new ConflictException({ code: NO_TRANSFERS_CODE, message: 'No hay transferencias pendientes que hacer.' });
    }
    const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
    const file = refundTransfersSepa({
      messageId: `OXPD${stamp}${randomBytes(3).toString('hex').toUpperCase()}`,
      createdAt: now,
      executionDate: madridDay(now),
      brand: partyBrand(),
      debtor: { name: venue.settlementHolder?.trim() || venue.name, iban: venue.settlementIban },
      transfers,
    });
    const ids = transfers.map((t) => t.id);
    await this.prisma.asSystem(async (tx) => {
      await lockSepaExports(tx, actor.tenantId, REFUNDS_SEPA_ACTION);
      const prev = await lastRefundsExport(tx, actor.tenantId, ids);
      if (prev && !opts.again) throw await alreadyExported(tx, prev);
      // En la misma transacción: sin registro no hay fichero (lo que avisa la próxima vez).
      await this.audit.logInTx(tx, {
        action: REFUNDS_SEPA_ACTION,
        tenantId: actor.tenantId,
        actorId: actor.userId,
        actorEmail: actor.email,
        targetType: 'Venue',
        targetId: actor.tenantId,
        payload: {
          messageId: file.messageId,
          transfers: file.count,
          totalCents: file.totalCents,
          ids,
          ...(prev ? { again: true, previousAt: prev.at.toISOString() } : {}),
        },
      });
    });
    return file;
  }

  private async settle(actor: Actor, id: string, to: 'DONE' | 'CANCELED', now: Date) {
    const result = await this.prisma.asSystem(async (tx) => {
      const first = await tx.partyRefundRequest.findFirst({ where: { id, tenantId: actor.tenantId }, select: { walletId: true } });
      if (!first) throw new NotFoundException('Devolución no encontrada');
      // El mismo orden que al pedirla: el saldo y después la petición.
      const wallet = await lockWallet(tx, first.walletId);
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM party_refund_requests WHERE id = ${id}::uuid FOR UPDATE
      `;
      if (locked[0]?.status !== 'PENDING') throw conflict(PARTY_REFUND_ERRORS.notPending, 'Esta devolución ya no está pendiente: vuelve a cargar la lista.');
      const row = await tx.partyRefundRequest.findUniqueOrThrow({ where: { id }, select: REQUEST_SELECT });
      const otherPending = await tx.partyRefundRequest.count({ where: { walletId: wallet.id, status: 'PENDING', id: { not: id } } });
      if (to === 'DONE') {
        await applyRefund(tx, wallet, row.amountCents, otherPending);
      } else if (otherPending === 0 && blockedByRefund(wallet)) {
        await tx.clientWallet.update({ where: { id: wallet.id }, data: { blockedAt: null, blockedReason: null } });
      }
      // Hecha o anulada, sin datos del asistente: el IBAN, el titular y el
      // correo ya no hacen falta (el CHECK personal_data de la tabla lo exige).
      const updated = await tx.partyRefundRequest.update({
        where: { id },
        data: { status: to, ...(to === 'DONE' ? { doneAt: now } : {}), doneById: actor.userId, iban: null, holderName: null, email: null },
        select: REQUEST_SELECT,
      });
      // En el registro, lo justo: ni el IBAN, ni el titular, ni el correo.
      await this.audit.logInTx(tx, {
        action: to === 'DONE' ? 'party.refund.done' : 'party.refund.canceled',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        actorEmail: actor.email,
        targetType: 'PartyRefundRequest',
        targetId: id,
        payload: { walletId: wallet.id, method: row.method, amountCents: row.amountCents },
      });
      const venue = await tx.venue.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { name: true } });
      const [view] = await rowViews(tx, [updated]);
      // El justificante (si dejó correo) sale con lo de antes de borrarlo, solo en memoria.
      return { row: { ...updated, email: row.email, iban: row.iban }, view: view!, venueName: venue.name, pulsera: view?.pulsera ?? null };
    });
    return result;
  }

  private async viewIn(tx: TransactionalClient, wallet: LockedWallet, now: Date): Promise<PartyRefundView> {
    const venue = await tx.venue.findUnique({ where: { id: wallet.tenantId }, select: { refundDeadline: true, allowDonation: true } });
    const deadline = dayOf(venue?.refundDeadline ?? null);
    const allowDonation = venue?.allowDonation ?? false;
    const { money } = await readMoney(tx, wallet);
    const mine = await tx.partyRefundRequest.findMany({
      where: { walletId: wallet.id, status: { in: ['PENDING', 'DONE'] } },
      orderBy: { createdAt: 'desc' },
      take: MINE_LIMIT,
      select: REQUEST_SELECT,
    });
    const usable = wallet.status === 'ACTIVE' && !wallet.mergedIntoId && (!wallet.blockedAt || blockedByRefund(wallet));
    const faceId = (await tx.walletPasskey.count({ where: { walletId: wallet.id } })) > 0;
    return {
      deadline,
      open: isRefundWindowOpen(deadline, now),
      allowDonation,
      balanceCents: Math.max(0, wallet.balanceCents),
      available: usable ? refundAvailability(money, allowDonation) : { ...ZERO_BY_METHOD },
      faceId,
      locked: mine.some((r) => r.status === 'PENDING'),
      requests: mine.map(mineView),
    };
  }

  /** El justificante, si dejó correo (sin esperar: un correo que no sale no deshace nada). */
  private sendMail(kind: RefundMailKind, row: RequestRow, venueName: string, pulsera: string | null): void {
    if (!row.email || !this.mail) return;
    const input = refundMail({
      kind,
      to: row.email,
      brand: partyBrand(),
      venueName,
      method: asMethod(row.method),
      amountCents: row.amountCents,
      pulsera,
      ibanHint: maskIban(row.iban),
      at: row.doneAt ?? row.createdAt,
    });
    void this.mail.send(input).then(
      (r) => {
        if (!r.ok) this.logger.warn(`Justificante de la devolución ${row.id} sin enviar: ${r.reason ?? 'error'}`);
      },
      (err: unknown) => this.logger.warn(`Justificante de la devolución ${row.id} sin enviar: ${(err as Error).message}`),
    );
  }
}

/** El saldo, bloqueado hasta el final de la transacción. */
async function lockWallet(tx: TransactionalClient, walletId: string): Promise<LockedWallet> {
  const rows = await tx.$queryRaw<LockedWallet[]>`
    SELECT id, "tenantId", status::text AS status, "balanceCents", "blockedAt", "blockedReason", "mergedIntoId"
      FROM client_wallets WHERE id = ${walletId}::uuid FOR UPDATE
  `;
  const wallet = rows[0];
  if (!wallet) throw new NotFoundException({ message: 'Saldo no encontrado', code: 'WALLET_NOT_FOUND' });
  return wallet;
}

/** El dinero del saldo para «Lo que sobra»: el efectivo que sigue dentro y lo pendiente por vía. */
async function readMoney(tx: TransactionalClient, wallet: { id: string; balanceCents: number }): Promise<{ money: RefundMoney; pendingCount: number }> {
  const [cash, transfers, pendingRows] = await Promise.all([
    walletCash(tx, wallet.id),
    tx.partyRefundRequest.aggregate({ where: { walletId: wallet.id, status: 'DONE', method: 'TRANSFER' }, _sum: { amountCents: true } }),
    tx.partyRefundRequest.findMany({ where: { walletId: wallet.id, status: 'PENDING' }, select: { method: true, amountCents: true, status: true } }),
  ]);
  return {
    money: {
      balanceCents: wallet.balanceCents,
      cashLeftCents: cash.inCents - cash.outCents - (transfers._sum.amountCents ?? 0),
      pending: pendingByMethod(pendingRows),
    },
    pendingCount: pendingRows.length,
  };
}

/** Lo hecho sale del saldo (a cero y sin más pendientes, se cierra); sin más pendientes, se desbloquea. */
async function applyRefund(tx: TransactionalClient, wallet: LockedWallet, amountCents: number, otherPending: number): Promise<void> {
  const after = walletAfterRefund(wallet, amountCents, otherPending);
  if (!after) {
    throw conflict(PARTY_REFUND_ERRORS.balance, 'El saldo ya no llega: se devolvió o se gastó por otro camino. Anula esta devolución.');
  }
  await tx.clientWallet.update({
    where: { id: wallet.id },
    data: {
      balanceCents: after.balanceCents,
      ...(after.status ? { status: after.status } : {}),
      ...(after.unblock ? { blockedAt: null, blockedReason: null } : {}),
    },
  });
}

/** «P-0412»: la pulsera dada al saldo (o la última que tuvo). */
async function walletPulsera(tx: TransactionalClient, walletId: string): Promise<string | null> {
  const card = await tx.walletCard.findFirst({
    where: { walletId },
    orderBy: [{ linkedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    select: { number: true },
  });
  return card ? pulseraLabel(card.number) : null;
}

/** Las filas del panel, con la pulsera, el código del saldo y quién la hizo. */
async function rowViews(tx: TransactionalClient, rows: ReadonlyArray<RequestRow>): Promise<PartyRefundRow[]> {
  if (rows.length === 0) return [];
  const walletIds = [...new Set(rows.map((r) => r.walletId))];
  const userIds = [...new Set(rows.flatMap((r) => (r.doneById ? [r.doneById] : [])))];
  const [wallets, cards, users] = await Promise.all([
    tx.clientWallet.findMany({ where: { id: { in: walletIds } }, select: { id: true, shortCode: true } }),
    tx.walletCard.findMany({
      where: { walletId: { in: walletIds } },
      orderBy: [{ linkedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: { walletId: true, number: true },
    }),
    userIds.length ? tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, email: true } }) : [],
  ]);
  const code = new Map(wallets.map((w) => [w.id, w.shortCode ? formatWalletCode(w.shortCode) : null]));
  const pulsera = new Map<string, string>();
  for (const c of cards) if (c.walletId && !pulsera.has(c.walletId)) pulsera.set(c.walletId, pulseraLabel(c.number));
  const name = new Map(users.map((u) => [u.id, u.displayName?.trim() || u.email.split('@')[0] || null]));
  return rows.map((r) => ({
    id: r.id,
    method: asMethod(r.method),
    status: asStatus(r.status),
    amountCents: r.amountCents,
    createdAt: r.createdAt.toISOString(),
    doneAt: r.doneAt?.toISOString() ?? null,
    doneByName: r.doneById ? (name.get(r.doneById) ?? null) : null,
    pulsera: pulsera.get(r.walletId) ?? null,
    walletCode: code.get(r.walletId) ?? null,
    ibanHint: maskIban(r.iban),
    holderName: r.holderName,
    email: r.email,
  }));
}
