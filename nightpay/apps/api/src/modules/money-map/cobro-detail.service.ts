import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  fichaNumberText,
  staffCan,
  staffPermissionsOf,
  type CobroDetail,
  type CobroDetailSensitive,
  type CobroKind,
  type JwtPayload,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { StepUpService } from '../auth/step-up.service';
import { mayReadCobro } from '../payments/payment-read-access';
import { adminPanelBaseUrl } from './admin-panel-url';
import { paymentDetailFacts, saldoDetailFacts, type AuditRow, type EarningRow } from './cobro-detail-facts';
import { shapeCobroDetail, type CobroDetailFacts, type CobroViewer, type DetailVerification } from './cobro-detail-policy';
import { peopleById } from './cobros.service';

const PERSON_SELECT = { id: true, displayName: true, email: true, role: true } as const;
const LINE_SELECT = {
  category: true,
  label: true,
  qty: true,
  unitCents: true,
  amountCents: true,
  serviceItemId: true,
  beneficiary: { select: PERSON_SELECT },
} as const;
const LINE_ORDER = [{ createdAt: 'asc' as const }, { amountCents: 'desc' as const }, { id: 'asc' as const }];
/** Lo que se lee de cada cosa como mucho (un cobro normal tiene unas pocas). */
const MAX_EVENTS = 200;
const MAX_AUDITS = 50;

/**
 * «Detalle del pago»: lo que ve cada uno al tocar un pago.
 *   GET /v1/admin/cobros/:kind/:id        → encargado y dueño, cualquiera del local.
 *   GET /v1/staff/me/cobros/:kind/:id     → la chica o el camarero, solo los suyos.
 *   GET /w/:token/movements/:kind/:id     → el cliente, solo los de su saldo.
 * Junta el cobro, sus líneas, intentos, eventos, devoluciones, ganancias y el
 * registro (cobro-detail-facts.ts) y lo recorta para quien mira
 * (cobro-detail-policy.ts). Lo delicado solo con la verificación del momento
 * (StepUpService): sin ella, `sensitive: null` y `verify.required`.
 * payment_lines, wallet_consumptions, operator_earnings y client_wallets
 * tienen FORCE RLS: todo dentro de una transacción (asSystem, con el local a mano).
 */
@Injectable()
export class CobroDetailService {
  private readonly prisma: PrismaService;
  private readonly stepUp: StepUpService | null;
  private readonly config: ConfigService | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Optional() @Inject(StepUpService) stepUp?: StepUpService,
    @Optional() @Inject(ConfigService) config?: ConfigService,
  ) {
    this.prisma = prisma;
    this.stepUp = stepUp ?? null;
    this.config = config ?? null;
  }

  /** Encargado y dueño: cualquier cobro de su local (de otro, 404). */
  async forManager(user: JwtPayload, kind: CobroKind, id: string): Promise<CobroDetail> {
    const facts = await this.factsIn(user.tenantId, kind, id);
    if (!facts) throw notFound();
    const viewer: CobroViewer = {
      audience: 'MANAGER',
      userId: user.sub,
      role: user.role === 'OWNER' ? 'OWNER' : 'MANAGER',
      canSeeSplit: await this.canSeeSplit(user),
    };
    return shapeCobroDetail(facts, viewer, await this.verificationOf(user));
  }

  /** La chica o el camarero: solo lo que hizo él o ella (lo de otra persona, 404 como si no existiera). */
  async forStaff(user: JwtPayload, kind: CobroKind, id: string): Promise<CobroDetail> {
    const owner = await this.ownerOf(user.tenantId, kind, id);
    if (owner === undefined || !mayReadCobro({ userId: user.sub, role: 'STAFF' }, owner)) throw notFound();
    const facts = await this.factsIn(user.tenantId, kind, id);
    if (!facts) throw notFound();
    return shapeCobroDetail(facts, { audience: 'STAFF', userId: user.sub }, await this.verificationOf(user));
  }

  /** Lo delicado pedido aparte: sin la verificación vigente, 403 STEP_UP_REQUIRED. */
  async sensitiveFor(user: JwtPayload, kind: CobroKind, id: string, as: 'MANAGER' | 'STAFF'): Promise<CobroDetailSensitive> {
    if (!this.stepUp) throw notFound();
    await this.stepUp.assertVerified(actorOf(user));
    const detail = as === 'MANAGER' ? await this.forManager(user, kind, id) : await this.forStaff(user, kind, id);
    if (!detail.sensitive) throw notFound();
    return detail.sensitive;
  }

  /** El cliente: solo los pagos de su saldo (las recargas y lo que pagó con él). */
  async forClient(walletId: string, kind: CobroKind, id: string): Promise<CobroDetail> {
    const tenantId = await this.prisma.acrossVenues(async (tx) => {
      if (kind === 'SALDO') {
        const r = await tx.walletChargeRequest.findFirst({ where: { id, walletId }, select: { tenantId: true } });
        return r?.tenantId ?? null;
      }
      const p = await tx.payment.findFirst({ where: { id, walletId }, select: { tenantId: true } });
      return p?.tenantId ?? null;
    });
    if (!tenantId) throw notFound();
    const facts = await this.factsIn(tenantId, kind, id);
    if (!facts) throw notFound();
    return shapeCobroDetail(facts, { audience: 'CLIENT' }, null);
  }

  // ─── Lectura ──────────────────────────────────────────────────────────

  /** Quién lo hizo (null: nadie del local); undefined: no es de este local. */
  private async ownerOf(tenantId: string, kind: CobroKind, id: string): Promise<string | null | undefined> {
    return this.prisma.asSystem(async (tx) => {
      if (kind === 'SALDO') {
        const r = await tx.walletChargeRequest.findFirst({ where: { id, tenantId }, select: { requestedByUserId: true } });
        return r ? r.requestedByUserId : undefined;
      }
      const p = await tx.payment.findFirst({ where: { id, tenantId }, select: { createdByUserId: true } });
      return p ? p.createdByUserId : undefined;
    });
  }

  private async factsIn(tenantId: string, kind: CobroKind, id: string): Promise<CobroDetailFacts | null> {
    const panelBase = adminPanelBaseUrl(this.envOf());
    return this.prisma.asSystem((tx) => (kind === 'SALDO' ? this.saldoFacts(tx, tenantId, id, panelBase) : this.paymentFacts(tx, tenantId, id, panelBase)));
  }

  private async paymentFacts(tx: TransactionalClient, tenantId: string, id: string, panelBase: string | null): Promise<CobroDetailFacts | null> {
    const p = await tx.payment.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        tenantId: true,
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
        cardType: true,
        cardCountry: true,
        secure3ds: true,
        payMethodCode: true,
        tokenizationData: true,
        authorizedAt: true,
        platformCommissionBps: true,
        idempotencyKey: true,
        createdByUserId: true,
        attempts: {
          select: { providerTxId: true, status: true, createdAt: true, amountCents: true, tipCents: true, payMethod: true },
          orderBy: { createdAt: 'asc' },
        },
        terminal: { select: { externalId: true, label: true } },
        createdBy: { select: PERSON_SELECT },
        wallet: { select: { id: true, shortCode: true } },
        lines: { select: LINE_SELECT, orderBy: LINE_ORDER },
        events: { select: { eventType: true, payload: true, occurredAt: true }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: MAX_EVENTS },
        refunds: {
          select: {
            id: true,
            amountCents: true,
            reason: true,
            requestedBy: true,
            status: true,
            createdAt: true,
            registeredManually: true,
            bankRefundedAt: true,
            serviceFeeCents: true,
            // «Devolver en efectivo» (bitcoin): el detalle y el ticket dicen «Devuelto en efectivo».
            paidInCash: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!p) return null;
    const [venue, earnings, audits] = await Promise.all([
      tx.venue.findUnique({ where: { id: tenantId }, select: { name: true } }),
      earningsOf(tx, tenantId, { paymentId: id }),
      tx.auditEvent.findMany({
        where: { tenantId, targetId: id },
        orderBy: { occurredAt: 'asc' },
        take: MAX_AUDITS,
        select: { action: true, actorId: true, payload: true, occurredAt: true },
      }),
    ]);
    const people = await peopleById(tx, [
      ...(p.createdByUserId ? [p.createdByUserId] : []),
      ...p.refunds.map((r) => r.requestedBy),
      ...earnings.map((e) => e.operatorId),
      ...audits.flatMap((a) => (a.actorId ? [a.actorId] : [])),
      ...p.events.flatMap((e) => peopleInPayload(e.payload)),
    ]);
    return paymentDetailFacts({ payment: p, venueName: venue?.name ?? '', people, earnings, audits: audits as AuditRow[], panelBase });
  }

  private async saldoFacts(tx: TransactionalClient, tenantId: string, id: string, panelBase: string | null): Promise<CobroDetailFacts | null> {
    const r = await tx.walletChargeRequest.findFirst({
      where: { id, tenantId },
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
        walletId: true,
        tipCents: true,
        decidedAt: true,
        wallet: { select: { id: true, shortCode: true } },
        lines: { select: LINE_SELECT, orderBy: LINE_ORDER },
      },
    });
    if (!r) return null;
    const consumption = r.consumptionId
      ? await tx.walletConsumption.findUnique({
          where: { id: r.consumptionId },
          select: {
            amountCents: true,
            tipCents: true,
            reversedAt: true,
            reversedByUserId: true,
            notes: true,
            authMethod: true,
            platformCommissionBps: true,
            serviceFeeSaldoCents: true,
          },
        })
      : null;
    const targets = [r.id, ...(r.consumptionId ? [r.consumptionId] : [])];
    const [venue, linkedEvents, earnings, audits, copies, ficha] = await Promise.all([
      tx.venue.findUnique({ where: { id: tenantId }, select: { name: true, platformCommissionBps: true } }),
      r.linkedPaymentId
        ? tx.paymentEvent.findMany({
            where: { paymentId: r.linkedPaymentId, tenantId },
            select: { eventType: true, payload: true, occurredAt: true },
            orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
            take: MAX_EVENTS,
          })
        : Promise.resolve([]),
      r.consumptionId ? earningsOf(tx, tenantId, { consumptionId: r.consumptionId }) : Promise.resolve([] as EarningRow[]),
      tx.auditEvent.findMany({
        where: { tenantId, targetId: { in: targets } },
        orderBy: { occurredAt: 'asc' },
        take: MAX_AUDITS,
        select: { action: true, actorId: true, payload: true, occurredAt: true },
      }),
      // La sospecha de copia de la ficha va con el saldo (targetId) y el cobro en el payload.
      tx.auditEvent.findMany({
        where: { tenantId, action: 'wallet.card_copy_suspected', payload: { path: ['requestId'], equals: r.id } },
        take: 5,
        select: { action: true, actorId: true, payload: true, occurredAt: true },
      }),
      r.walletId ? fichaAt(tx, r.walletId, r.decidedAt ?? r.createdAt) : Promise.resolve(null),
    ]);
    const people = await peopleById(tx, [
      r.requestedByUserId,
      ...(consumption?.reversedByUserId ? [consumption.reversedByUserId] : []),
      ...earnings.map((e) => e.operatorId),
      ...[...audits, ...copies].flatMap((a) => (a.actorId ? [a.actorId] : [])),
      ...linkedEvents.flatMap((e) => peopleInPayload(e.payload)),
      ...audits.flatMap((a) => peopleInPayload(a.payload)),
    ]);
    return saldoDetailFacts({
      request: r,
      consumption: consumption ? { ...consumption, tipCents: consumption.tipCents ?? 0 } : null,
      wallet: r.wallet,
      lines: r.lines,
      linkedEvents,
      people,
      earnings,
      audits: [...audits, ...copies] as AuditRow[],
      fichaNumber: ficha,
      venueName: venue?.name ?? '',
      venuePlatformBps: venue?.platformCommissionBps ?? 0,
      panelBase,
    });
  }

  // ─── Quién ve qué ─────────────────────────────────────────────────────

  /** El reparto entero: el dueño siempre; el encargado, con el permiso «Informes» (como el mapa del dinero). */
  private async canSeeSplit(user: JwtPayload): Promise<boolean> {
    if (user.role === 'OWNER') return true;
    const venue = await this.prisma.asSystem((tx) => tx.venue.findUnique({ where: { id: user.tenantId }, select: { staffPermissions: true } }));
    return staffCan(staffPermissionsOf(venue?.staffPermissions), { role: user.role, userId: user.sub }, 'reports');
  }

  private async verificationOf(user: JwtPayload): Promise<DetailVerification> {
    if (!this.stepUp) return { verifiedUntil: null, method: null };
    const status = await this.stepUp.status(actorOf(user));
    return { verifiedUntil: status.verifiedUntil, method: status.method };
  }

  private envOf(): { adminBaseUrl?: string; apiUrl?: string; production: boolean } {
    const get = (k: string): string | undefined => this.config?.get<string>(k) ?? process.env[k];
    return { adminBaseUrl: get('ADMIN_BASE_URL'), apiUrl: get('NEXT_PUBLIC_API_URL'), production: get('NODE_ENV') === 'production' };
  }
}

function notFound(): NotFoundException {
  return new NotFoundException('Cobro no encontrado');
}

function actorOf(user: JwtPayload): { userId: string; sessionId: string | null; tenantId: string; email: string } {
  return { userId: user.sub, sessionId: user.sid ?? null, tenantId: user.tenantId, email: user.email };
}

/** Las personas que nombra un evento o un registro (quién canceló, quién confirmó, de quién era el móvil). */
function peopleInPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  return ['userId', 'byUserId', 'confirmedByUserId'].flatMap((k) => (typeof p[k] === 'string' && p[k] ? [p[k] as string] : []));
}

/** Las ganancias del cobro (o del consumo) con lo que ya debe cada uno si se le pagó antes de devolverlo. */
async function earningsOf(tx: TransactionalClient, tenantId: string, where: { paymentId: string } | { consumptionId: string }): Promise<EarningRow[]> {
  const rows = await tx.operatorEarning.findMany({
    where: { tenantId, ...where },
    select: { id: true, operatorId: true, commissionCents: true, tipCents: true, reversedCents: true, paymentLineId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];
  const debts = await tx.earningReversal.groupBy({
    by: ['earningId'],
    where: { tenantId, earningId: { in: rows.map((e) => e.id) }, afterPayout: true },
    _sum: { reversedDeltaCents: true },
  });
  const debtOf = new Map(debts.map((d) => [d.earningId, d._sum.reversedDeltaCents ?? 0]));
  return rows.map((e) => ({
    operatorId: e.operatorId,
    commissionCents: e.commissionCents,
    tipCents: e.tipCents ?? 0,
    reversedCents: e.reversedCents,
    paymentLineId: e.paymentLineId,
    debtCents: debtOf.get(e.id) ?? 0,
  }));
}

/** La ficha NFC que tenía el saldo al pagar: «Ficha nº 00736903» (la impresa) o la interna («0522»). */
async function fichaAt(tx: TransactionalClient, walletId: string, at: Date): Promise<string | null> {
  const issued = await tx.walletCardEvent.findFirst({
    where: { walletId, kind: 'ISSUED', at: { lte: at } },
    orderBy: { at: 'desc' },
    select: { card: { select: { number: true, printedNumber: true } } },
  });
  const card =
    issued?.card ??
    (await tx.walletCard.findFirst({ where: { walletId }, orderBy: { linkedAt: 'desc' }, select: { number: true, printedNumber: true } }));
  return card ? (card.printedNumber ?? fichaNumberText(card.number)) : null;
}
