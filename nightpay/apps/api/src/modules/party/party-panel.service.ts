import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  isEventEnded,
  type JwtPayload,
  type PartyCashDesk,
  type PartyLive,
  type PartyLiveQuery,
  type PartySettlement,
  type PartySettlementQuery,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { madridDay } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { REPORT_TX } from '../reports/reporting-sql';
import { buildPartyLive, totalsByStall, type StallTotals } from './party-live-rules';
import {
  cardTopUps,
  cashPayouts,
  cashTopUps,
  deskNames,
  stallMeta,
  stallSalesByHour,
  walletPayoutsTotal,
  wristbandsNow,
  type SqlWindow,
} from './party-money-sql';
import { buildPartySettlement, type SettlementStall } from './party-settlement-rules';
import { currentNightWindow, eventNights, eventWindow, nightOf, nightWindow, nightsRange, type PartyWindow } from './party-windows';
import { buildPain001, type Pain001Transfer } from './sepa';

/** Lo que se lee del local (la fiesta). */
const VENUE_SELECT = {
  name: true,
  cashAlertCents: true,
  eventStartsAt: true,
  eventEndsAt: true,
  settlementIban: true,
  settlementHolder: true,
} as const;

interface VenueRow {
  name: string;
  cashAlertCents: number;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  settlementIban: string | null;
  settlementHolder: string | null;
}

export const NO_DEBTOR_IBAN_CODE = 'NO_DEBTOR_IBAN';
export const NO_TRANSFERS_CODE = 'NO_TRANSFERS';

/** El fichero del banco: la liquidación y el XML. */
export interface PartySepaFile {
  settlement: PartySettlement;
  xml: string;
}

/**
 * El panel del organizador de OxioParty: en directo, la caja de cada taquilla
 * y la liquidación por caseta (con su fichero SEPA y su CSV). Solo lectura:
 * todo dentro de withTenant (FORCE RLS) con el local explícito en el SQL.
 */
@Injectable()
export class PartyPanelService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** En directo: la noche de ahora, una noche concreta o la fiesta entera. */
  async live(tenantId: string, q: PartyLiveQuery, now: Date = new Date()): Promise<PartyLive> {
    const venue = await this.venue(tenantId);
    const ended = isEventEnded(venue.eventEndsAt, now);
    const window: PartyWindow =
      q.scope === 'event' ? eventWindow(now, ended) : q.night ? nightWindow(q.night, now) : currentNightWindow(now);
    const data = await this.prisma.withTenant(
      tenantId,
      async (tx) => {
        const sales = await stallSalesByHour(tx, tenantId, window, now);
        const card = await cardTopUps(tx, tenantId, window, now);
        const cash = await cashTopUps(tx, tenantId, window, now);
        const payouts = await cashPayouts(tx, tenantId, window);
        const meta = await stallMeta(tx, tenantId);
        const wristbands = await wristbandsNow(tx, tenantId);
        const names = await deskNames(tx, tenantId, {
          people: unique([...card.filter((r) => r.kind === 'person'), ...cash.filter((r) => r.kind === 'person')].map((r) => r.who), payouts.map((p) => p.who)),
          terminals: unique([...card.filter((r) => r.kind === 'terminal'), ...cash.filter((r) => r.kind === 'terminal')].map((r) => r.who)),
        });
        return { sales, card, cash, payouts, meta, wristbands, names };
      },
      REPORT_TX,
    );
    return buildPartyLive({
      scope: q.scope,
      night: q.scope === 'event' ? null : (q.night ?? nightOf(now)),
      window,
      now,
      idleMinutes: q.idleMin,
      event: {
        name: venue.name,
        startsAt: venue.eventStartsAt,
        endsAt: venue.eventEndsAt,
        ended,
        nights: eventNights(venue.eventStartsAt, venue.eventEndsAt, now),
      },
      cashAlertCents: venue.cashAlertCents,
      stallMeta: data.meta,
      sales: data.sales,
      card: data.card,
      cash: data.cash,
      payouts: data.payouts,
      people: data.names.people,
      terminals: data.names.terminals,
      wristbands: data.wristbands,
    });
  }

  /**
   * La caja de quien lo pide (la taquilla), en la noche de ahora: sus
   * recargas en efectivo (con la «Comisión del servicio»; las anulaciones
   * restan) menos el saldo que devolvió en efectivo. Sin el fondo de caja.
   */
  async cashDesk(tenantId: string, userId: string, now: Date = new Date()): Promise<PartyCashDesk> {
    const window = currentNightWindow(now);
    const [venue, data] = await Promise.all([
      this.venue(tenantId),
      this.prisma.withTenant(
        tenantId,
        async (tx) => ({
          cash: await cashTopUps(tx, tenantId, window, now, userId),
          payouts: await cashPayouts(tx, tenantId, window, userId),
        }),
        REPORT_TX,
      ),
    ]);
    const cashInCents = data.cash.reduce((a, r) => a + r.cents + r.feeCents, 0);
    const cashOutCents = data.payouts.reduce((a, r) => a + r.cents, 0);
    const cashCents = cashInCents - cashOutCents;
    return {
      from: (window.from ?? now).toISOString(),
      to: window.to.toISOString(),
      cashInCents,
      topUpsCount: data.cash.reduce((a, r) => a + r.count, 0),
      cashOutCents,
      payoutsCount: data.payouts.reduce((a, r) => a + r.count, 0),
      cashCents,
      alertCents: venue.cashAlertCents,
      overAlert: venue.cashAlertCents > 0 && cashCents > venue.cashAlertCents,
    };
  }

  /** Lo que se paga a cada caseta: unas noches (from, to) o la fiesta entera. */
  async settlement(tenantId: string, q: PartySettlementQuery, now: Date = new Date()): Promise<PartySettlement> {
    return (await this.settlementWithIbans(tenantId, q, now)).settlement;
  }

  /**
   * El fichero SEPA (pain.001.001.03) de la liquidación: el deudor es el
   * local (su cuenta de cobro, que pone OxioPay), los acreedores las casetas
   * con IBAN y algo que pagar («barra propia» fuera). Queda en el registro.
   */
  async sepa(actor: JwtPayload, q: PartySettlementQuery, now: Date = new Date()): Promise<PartySepaFile> {
    const { settlement, ibans, venue } = await this.settlementWithIbans(actor.tenantId, q, now);
    if (!venue.settlementIban) {
      throw new ConflictException({
        code: NO_DEBTOR_IBAN_CODE,
        message: 'El local no tiene su cuenta (IBAN) para hacer las transferencias: la pone OxioPay. Pídesela y vuelve a probar.',
      });
    }
    const ready = settlement.rows.filter((r) => r.status === 'READY' && r.stallId !== null);
    if (ready.length === 0) {
      throw new ConflictException({
        code: NO_TRANSFERS_CODE,
        message: 'No hay transferencias que hacer: ninguna caseta tiene IBAN y algo que cobrar.',
      });
    }
    const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
    const messageId = `OXP${stamp}${randomBytes(3).toString('hex').toUpperCase()}`;
    const transfers: Pain001Transfer[] = ready.map((r, i) => ({
      endToEndId: `${messageId.slice(0, 26)}-${String(i + 1).padStart(3, '0')}`,
      creditorName: r.name,
      creditorIban: ibans.get(r.stallId as string) as string,
      amountCents: r.toPayCents,
      remittance: `OxioParty ${settlement.eventName} ${r.name}`,
    }));
    const xml = buildPain001({
      messageId,
      createdAt: now,
      executionDate: madridDay(now),
      debtor: { name: venue.settlementHolder?.trim() || venue.name, iban: venue.settlementIban },
      transfers,
    });
    await this.audit.log({
      action: 'party.settlement.sepa_exported',
      tenantId: actor.tenantId,
      actorId: actor.sub,
      actorEmail: actor.email,
      targetType: 'Venue',
      targetId: actor.tenantId,
      payload: {
        messageId,
        transfers: transfers.length,
        totalCents: settlement.totals.transfersCents,
        fromNight: settlement.fromNight,
        toNight: settlement.toNight,
      },
    });
    return { settlement, xml };
  }

  // ─── internos ──────────────────────────────────────────────────────

  private async settlementWithIbans(
    tenantId: string,
    q: PartySettlementQuery,
    now: Date,
  ): Promise<{ settlement: PartySettlement; ibans: Map<string, string>; venue: VenueRow }> {
    const venue = await this.venue(tenantId);
    const window: PartyWindow =
      q.from && q.to ? nightsRange(q.from, q.to, now) : eventWindow(now, isEventEnded(venue.eventEndsAt, now));
    const data = await this.prisma.withTenant(tenantId, (tx) => this.settlementRows(tx, tenantId, window, now), REPORT_TX);
    const settlement = buildPartySettlement({
      window,
      fromNight: q.from ?? null,
      toNight: q.to ?? null,
      now,
      eventName: venue.name,
      stalls: data.stalls,
      totals: data.totals,
      debtor: { name: venue.settlementHolder?.trim() || venue.name, iban: venue.settlementIban },
      wristbands: data.wristbands,
    });
    const ibans = new Map(data.stalls.flatMap((s) => (s.iban ? [[s.id, s.iban] as const] : [])));
    return { settlement, ibans, venue };
  }

  private async settlementRows(
    tx: TransactionalClient,
    tenantId: string,
    window: SqlWindow,
    now: Date,
  ): Promise<{ stalls: SettlementStall[]; totals: Map<string | null, StallTotals>; wristbands: PartySettlement['wristbands'] }> {
    const sales = await stallSalesByHour(tx, tenantId, window, now);
    const stalls = await tx.stall.findMany({
      where: { tenantId },
      select: { id: true, name: true, managerName: true, organizerBps: true, iban: true, active: true, sortOrder: true },
    });
    const card = await cardTopUps(tx, tenantId, window, now);
    const cash = await cashTopUps(tx, tenantId, window, now);
    const refundedCents = await walletPayoutsTotal(tx, tenantId, window);
    const live = await wristbandsNow(tx, tenantId);
    const loadedCents = card.reduce((a, r) => a + r.cents, 0) + cash.reduce((a, r) => a + r.cents, 0);
    return { stalls, totals: totalsByStall(sales), wristbands: { loadedCents, refundedCents, leftCents: live.balanceCents } };
  }

  private venue(tenantId: string): Promise<VenueRow> {
    return this.prisma.asSystem((tx) => tx.venue.findUniqueOrThrow({ where: { id: tenantId }, select: VENUE_SELECT }));
  }
}

function unique(...lists: ReadonlyArray<ReadonlyArray<string | null>>): string[] {
  return [...new Set(lists.flat().filter((x): x is string => Boolean(x)))];
}
