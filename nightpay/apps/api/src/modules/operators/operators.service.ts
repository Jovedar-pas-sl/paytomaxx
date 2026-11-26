import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { isPartyEdition } from '../../config/edition';
import { EmailService } from '../../common/email/email.service';
import { idDocumentData, idDocumentView, openIdDocument } from './id-document';
import { liveStaffCards, revokeLiveStaffCard } from './staff-cards.service';
import { photoHashesOf } from '../profile/photo-hashes';
import { AuditService } from '../audit/audit.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { NOT_SALDO_TWIN, saldoCharges } from '../money-map/cobros.service';
import { PayoutVerifierFactory } from '../treasury/payout-verifier.factory';
import { isUniqueViolation, otherPayoutWithTx, txAlreadyUsed } from '../treasury/payout-tx-guard';
import { isAutoVerifiable } from '../treasury/verifiers/payout-verifier.interface';
import { operatorAppBaseUrl } from './operator-app-url';
import {
  replayPayout,
  type PayoutCreatedView,
  type PayoutIdempotency,
} from './payout-idempotency';
import { debtView, payoutAccountView, type DebtRow, type MyPayoutInfo } from './my-payout-info';
import { myPaymentsPage, type MyPaymentRow } from './my-payments';
import { historyOrder, historyPage, historyRange, historyWhere, type HistoryRange } from './my-history';
import { StaffPushService } from './staff-push.service';
import { earningBankHeldSql, earningNetSql } from './bank-hold-sql';
import { SERVED_EARNING_SQL, SERVICE_DISPUTED_ACTION } from './served-earning';
import { availableCentsOf, payoutCutoff, payoutTotalCents } from './payout-math';
import {
  exactSelection,
  lockOperatorPayouts,
  payableSelection,
  payoutChanged,
  payoutTotalChanged,
  settleSelection,
  type ExactPayout,
} from './payout-selection';
import { PAYEE_ROLES, type PayeeRole } from './payee-roles';
import { venueHoldDays } from './venue-hold-days';
import {
  PAYOUT_ACCOUNT_SELECT,
  accountForAudit,
  maskedPayoutAccount,
  openPayoutAccount,
  payoutAccountChangedMeanwhile,
  planPayoutAccountChange,
  type PayoutAccountPlan,
  type StoredPayoutAccount,
} from './payout-account';
import { notifyPayoutAccountChanged, payoutAccountTooNew, type PayoutChangeVia } from './payout-account-notices';
import { touchesPayoutAccount } from './payout-routing';
import { isRecordNotFound, selfOnboardingAlreadySaved, usedTokenMarker } from './self-onboarding-token';
import {
  becomesMinor,
  birthDateOf,
  birthDateRequired,
  birthDateValue,
  legalNameData,
  legalNameView,
  minorCannotActivate,
  minorLockData,
  minorNow,
  oxiocardView,
  payoutHolderNotConfirmed,
  payoutHolderUnconfirmed,
} from './alta-identity';
import type {
  CreateOperatorDto,
  CreateOperatorResponse,
  OperatorBalance,
  OperatorPublicView,
  OperatorWithBalance,
  OwnHistoryPage,
  OwnHistoryQuery,
  OxiocardStatus,
  OxiocardView,
  Role,
  EarningView,
  IdDocumentFull,
  PayoutAccountFull,
  PayoutAccountNotice,
  PayoutMetadata,
  PayoutMethod,
  PayoutView,
  SelfOnboardingLinkResponse,
  SelfOnboardingProfile,
  SelfOnboardingSubmitDto,
  UpdateOperatorDto,
} from '@nightpay/contracts';
import { formatChargeRef, holderMatchesName, maskHolderName, maskIdDocumentNumber, maskPayoutAddress, payoutMetadataFor } from '@nightpay/contracts';
import { eur } from '../../common/money/eur';

const INVITE_TTL_HOURS = 24;
const SELF_ONBOARDING_TTL_HOURS = 72;
const COMMISSION_OWNER_ONLY_NOTICE =
  'La comisión la fija el dueño: a esta chica se le aplica la del local hasta que él la cambie.';
const OXIOCARD_OFF = 'La OxioCard aún no está disponible.';

/**
 * Hash para la columna NOT NULL cuando no hay contraseña que valga (alta o
 * menor de edad). Cost 4 (mínimo) a propósito: NUNCA se verifica con
 * bcrypt.compare (al aceptar la invitación se pisa con uno de cost 10). NO
 * REUTILIZAR cost 4 para hashes que sí se verifican (el estándar es 10).
 */
function placeholderPasswordHash(): Promise<string> {
  return bcrypt.hash(randomUUID(), 4);
}

interface InviteJwtPayload {
  sub: string; // userId
  tenantId: string;
  purpose: 'operator-invite';
}

interface SelfOnboardingJwtPayload {
  sub: string; // operatorId
  tenantId: string;
  purpose: 'operator-self-onboarding';
  /** Enlace generado por el dueño: la chica puede poner su PRIMERA cuenta de cobro. */
  payout?: boolean;
}

/** Hash sha256 hex del token JWT. Persistimos el hash, no el token, en users.inviteToken. */
function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** El encargado no fija comisiones: la que mande se ignora (se aplica la del local). */
function commissionOnCreate(actorRole: Role, requested: number | undefined): { commissionBps: number | null; ignored: boolean } {
  if (actorRole === 'OWNER') return { commissionBps: requested ?? null, ignored: false };
  return { commissionBps: null, ignored: requested !== undefined };
}

/** Opciones de createPayout (referencia externa y lo de «Por aprobar»). */
export interface PayoutOptions {
  externalTxId?: string;
  externalRail?: string;
  receiptUrl?: string;
  /** Dentro de la transacción, con el candado de la chica, antes de leer sus comisiones. */
  inTransaction?: (tx: TransactionalClient) => Promise<void>;
  /** Pago aprobado: exactamente estas comisiones y deudas, por este total. */
  exact?: ExactPayout;
  /** La cifra que vio quien paga: si lo pagable ya es otro total, 409 PAYOUT_CHANGED. */
  expectedTotalCents?: number;
  /** Idempotency-Key de la petición: repetida, devuelve el mismo pago (payout-idempotency). */
  idempotency?: PayoutIdempotency;
  /** En la misma transacción, con el pago ya creado. */
  afterCreate?: (tx: TransactionalClient, payoutId: string) => Promise<void>;
  /** Para el registro. */
  approvalRequestId?: string;
  /** «Pagar» a varias a la vez: la clave de la tanda, para el registro del pago. */
  batchKey?: string;
}

/** Ya tiene a dónde se le paga. */
function hasPayoutRouting(u: { payoutMethod?: string | null; payoutAddress?: string | null }): boolean {
  return Boolean(u.payoutMethod || u.payoutAddress);
}

@Injectable()
export class OperatorsService {
  private readonly logger = new Logger(OperatorsService.name);
  private readonly prisma: PrismaService;
  private readonly email: EmailService;
  private readonly audit: AuditService;
  private readonly config: ConfigService;
  private readonly jwt: JwtService;
  private readonly fxFactory: PayoutVerifierFactory;
  private readonly sessions: RefreshTokenService;
  /** «Te han pagado» al móvil de la persona (sin él, p. ej. en las pruebas, no se avisa). */
  private readonly staffPush: StaffPushService | undefined;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(EmailService) email: EmailService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(JwtService) jwt: JwtService,
    @Inject(PayoutVerifierFactory) fxFactory: PayoutVerifierFactory,
    @Inject(RefreshTokenService) sessions: RefreshTokenService,
    @Optional() @Inject(StaffPushService) staffPush?: StaffPushService,
  ) {
    this.prisma = prisma;
    this.email = email;
    this.audit = audit;
    this.config = config;
    this.jwt = jwt;
    this.fxFactory = fxFactory;
    this.sessions = sessions;
    this.staffPush = staffPush;
  }

  /**
   * La app de las chicas (enlaces de invitación y onboarding). Si no se sabe,
   * avisa ANTES de crear o cambiar nada.
   */
  private operatorAppUrl(): string {
    const url = operatorAppBaseUrl({
      operatorBaseUrl: this.config.get<string>('OPERATOR_BASE_URL'),
      operatorUrl: this.config.get<string>('NEXT_PUBLIC_OPERATOR_URL'),
      apiUrl: this.config.get<string>('NEXT_PUBLIC_API_URL'),
      production: this.config.get<string>('NODE_ENV') === 'production',
    });
    if (!url) throw new ServiceUnavailableException('Falta la dirección de la app de las chicas: configura OPERATOR_BASE_URL');
    return url;
  }

  /**
   * Rails cripto on-chain — usan FX snapshot al crear el payout.
   * Otros métodos (e-wallet, wire, LatAm, cash) son fiat directo, sin FX.
   */
  private static readonly CRYPTO_RAILS = new Set<string>([
    'USDT_TRC20',
    'USDT_BEP20',
    'USDC_POLY',
    'USDC_SOL',
    'BINANCE_PAY_ID',
    'OKX_INTERNAL',
    'BYBIT_INTERNAL',
  ]);

  // ─── Operator self-service (role=OPERATOR) ────────────────────────
  // Todas las funciones aceptan tenantId obligatorio + filtran la query raw
  // por AND "tenantId" para defensa cross-tenant (no depender solo de RLS o
  // del middleware CLS).

  async getBalance(operatorId: string, tenantId: string): Promise<OperatorBalance> {
    const cutoff = payoutCutoff(new Date(), await this.holdDays(tenantId));
    // `bank`: sin pagar y de una venta por datáfono sin cuadrar con el banco
    // (bank-hold-sql). Lo retenido va aparte de lo «en espera» (no se solapan).
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<
      Array<{
        pendingCents: bigint;
        heldCents: bigint;
        bankHeldCents: bigint;
        bankHeldCount: bigint;
        paidCents: bigint;
        lifetimeGrossCents: bigint;
        count: bigint;
      }>
    >`
      SELECT
        COALESCE(SUM(CASE WHEN x."payoutId" IS NULL THEN x.net ELSE 0 END), 0)::bigint AS "pendingCents",
        COALESCE(SUM(CASE WHEN x."payoutId" IS NULL AND NOT x.bank AND x."createdAt" > ${cutoff} THEN x.net ELSE 0 END), 0)::bigint AS "heldCents",
        COALESCE(SUM(CASE WHEN x.bank THEN x.net ELSE 0 END), 0)::bigint AS "bankHeldCents",
        COUNT(DISTINCT x."paymentId") FILTER (WHERE x.bank AND x.net > 0)::bigint AS "bankHeldCount",
        COALESCE(SUM(CASE WHEN x."payoutId" IS NOT NULL THEN x.net ELSE 0 END), 0)::bigint AS "paidCents",
        COALESCE(SUM(x."paymentAmountCents"), 0)::bigint AS "lifetimeGrossCents",
        COUNT(*)::bigint AS count
      FROM (
        SELECT e."payoutId", e."createdAt", e."paymentId", e."paymentAmountCents", ${earningNetSql('e')} AS net,
               (e."payoutId" IS NULL AND ${earningBankHeldSql('e')}) AS bank
          FROM operator_earnings e
         WHERE e."operatorId" = ${operatorId}::uuid
           AND e."tenantId" = ${tenantId}::uuid
      ) x
    `);
    const r = rows[0]!;
    const debtCents = await this.openDebtCents(operatorId, tenantId);
    const unpaid = Number(r.pendingCents);
    const held = Math.max(0, Number(r.heldCents));
    const bankHeld = Math.max(0, Number(r.bankHeldCents ?? 0));
    return {
      pendingCents: unpaid - debtCents,
      availableCents: availableCentsOf({ unpaidCents: unpaid, heldCents: held, bankHeldCents: bankHeld, debtCents }),
      heldCents: held,
      bankHeldCents: bankHeld,
      bankHeldCount: Number(r.bankHeldCount ?? 0),
      debtCents,
      paidCents: Math.max(0, Number(r.paidCents)),
      lifetimeGrossCents: Number(r.lifetimeGrossCents),
      count: Number(r.count),
    };
  }

  /** Los del local (regla del super-admin; 0 = al cierre de la noche) o PAYOUT_HOLD_DAYS. */
  private holdDays(tenantId: string): Promise<number> {
    return venueHoldDays(this.prisma, this.config.get('PAYOUT_HOLD_DAYS'), tenantId);
  }

  /** Devoluciones llegadas con la comisión ya pagada, aún sin descontar. */
  private async openDebtCents(operatorId: string, tenantId: string): Promise<number> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM(r."reversedDeltaCents"), 0)::bigint AS total
        FROM earning_reversals r
        JOIN operator_earnings e ON e.id = r."earningId"
       WHERE e."operatorId" = ${operatorId}::uuid
         AND e."tenantId" = ${tenantId}::uuid
         AND r."afterPayout"
         AND r."settledPayoutId" IS NULL
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /** Sus últimas `limit` comisiones (el resumen de «Ganancias» y el panel). */
  async getMyEarnings(
    operatorId: string,
    tenantId: string,
    limit = 50,
  ): Promise<EarningView[]> {
    return this.earningRows(operatorId, tenantId, limit, null);
  }

  /** «Historial» de sus ganancias en la app: por páginas y entre dos fechas. */
  async myEarningsPage(operatorId: string, tenantId: string, q: OwnHistoryQuery): Promise<OwnHistoryPage<EarningView>> {
    return historyPage(await this.earningRows(operatorId, tenantId, q.limit + 1, historyRange(q)), q.limit);
  }

  private async earningRows(operatorId: string, tenantId: string, take: number, range: HistoryRange | null): Promise<EarningView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<
      Array<{
        id: string;
        paymentId: string | null;
        consumptionId: string | null;
        paymentAmountCents: number;
        commissionBps: number;
        commissionCents: number;
        tipCents: number;
        reversedCents: number;
        payoutId: string | null;
        paymentStatus: string | null;
        bankHeld: boolean;
        servedByName: string | null;
        notMineReported: boolean | null;
        serviceBaseCents: number | null;
        serviceBps: number | null;
        createdAt: Date;
      }>
    >`
      SELECT e.id, e."paymentId", e."consumptionId", e."paymentAmountCents", e."commissionBps", sv."serviceBaseCents", sv."serviceBps",
             e."commissionCents", COALESCE(e."tipCents",0) AS "tipCents",
             e."reversedCents", e."payoutId",
             p.status::text AS "paymentStatus", e."createdAt",
             (e."payoutId" IS NULL AND ${earningBankHeldSql('e')}) AS "bankHeld",
             s."servedByName",
             CASE WHEN s."servedByName" IS NOT NULL THEN EXISTS (
               SELECT 1 FROM audit_events a
                WHERE a."tenantId" = e."tenantId" AND a.action = ${SERVICE_DISPUTED_ACTION} AND a."targetId" = e.id::text
             ) END AS "notMineReported"
        FROM operator_earnings e
        LEFT JOIN payments p ON p.id = e."paymentId"
        LEFT JOIN wallet_consumptions c ON c.id = e."consumptionId"
        -- Un servicio que otra persona le cobró a su nombre: quién lo cobró.
        LEFT JOIN LATERAL (
          SELECT COALESCE(NULLIF(btrim(u."displayName"), ''), split_part(u.email, '@', 1)) AS "servedByName"
            FROM users u
           WHERE u.id = COALESCE(p."createdByUserId", c."providedByUserId") AND ${SERVED_EARNING_SQL}
        ) s ON true
        -- Y de esa cuenta, lo de Servicios que era suyo y su % (la copa de la misma cuenta no cuenta).
        LEFT JOIN LATERAL (
          SELECT SUM(l."amountCents")::int AS "serviceBaseCents", MAX(l."operatorCommissionBps")::int AS "serviceBps"
            FROM payment_lines l
            LEFT JOIN wallet_charge_requests w ON w.id = l."walletChargeId"
           WHERE s."servedByName" IS NOT NULL AND l."serviceOperatorId" = e."operatorId"
             AND (l."paymentId" = e."paymentId" OR w."consumptionId" = e."consumptionId")
        ) sv ON true
       WHERE e."operatorId" = ${operatorId}::uuid
         AND e."tenantId" = ${tenantId}::uuid
         ${historyWhere('e', range)}
       ORDER BY ${historyOrder('e', range)}
       LIMIT ${take}
    `);
    return rows.map((r) => ({
      id: r.id,
      paymentId: r.paymentId,
      paymentAmountCents: r.paymentAmountCents,
      commissionBps: r.commissionBps,
      commissionCents: r.commissionCents,
      tipCents: r.tipCents,
      reversedCents: r.reversedCents,
      netCents: r.commissionCents + r.tipCents - r.reversedCents,
      payoutId: r.payoutId,
      paymentStatus: r.paymentStatus,
      bankHeld: r.bankHeld === true,
      ...(r.servedByName === null ? {} : { servedByName: r.servedByName, notMineReported: r.notMineReported === true }),
      ...(r.serviceBaseCents && r.serviceBps !== null ? { serviceBaseCents: r.serviceBaseCents, serviceBps: r.serviceBps } : {}),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * «No es mío» (cobro por el encargado): la compañera dice que un servicio que
   * otra persona le cobró a su nombre no es suyo. Deja el aviso en el registro
   * (la incidencia service_disputed: Incidencias del panel, Telegram y la app
   * del encargado). No mueve dinero ni retiene su parte. Una vez por ganancia:
   * con la fila bloqueada, dos toques a la vez avisan una sola vez.
   */
  async notMine(operatorId: string, tenantId: string, earningId: string): Promise<{ reported: true }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          paymentId: string | null;
          paymentAmountCents: number;
          shareCents: number;
          ref: number | null;
          chargedById: string | null;
          chargedByName: string | null;
          operatorName: string | null;
        }>
      >`
        SELECT e."paymentId", e."paymentAmountCents", (e."commissionCents" + COALESCE(e."tipCents", 0))::int AS "shareCents",
               COALESCE(p.ref, w.ref) AS ref, cu.id::text AS "chargedById",
               COALESCE(NULLIF(btrim(cu."displayName"), ''), split_part(cu.email, '@', 1)) AS "chargedByName",
               COALESCE(NULLIF(btrim(me."displayName"), ''), split_part(me.email, '@', 1)) AS "operatorName"
          FROM operator_earnings e
          LEFT JOIN payments p ON p.id = e."paymentId"
          LEFT JOIN wallet_consumptions c ON c.id = e."consumptionId"
          LEFT JOIN wallet_charge_requests w ON w."consumptionId" = e."consumptionId"
          LEFT JOIN users cu ON cu.id = COALESCE(p."createdByUserId", c."providedByUserId")
          LEFT JOIN users me ON me.id = e."operatorId"
         WHERE e.id = ${earningId}::uuid AND e."operatorId" = ${operatorId}::uuid AND e."tenantId" = ${tenantId}::uuid
           AND ${SERVED_EARNING_SQL}
           FOR UPDATE OF e
      `;
      const row = rows[0];
      if (!row) throw new NotFoundException('Ese cobro no es un servicio cobrado a tu nombre.');
      const already = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM audit_events
         WHERE "tenantId" = ${tenantId}::uuid AND action = ${SERVICE_DISPUTED_ACTION} AND "targetId" = ${earningId}
         LIMIT 1
      `;
      if (already.length > 0) return { reported: true as const };
      const payload = {
        ref: row.ref === null ? null : formatChargeRef(row.ref),
        amountCents: row.paymentAmountCents,
        shareCents: row.shareCents,
        paymentId: row.paymentId,
        chargedById: row.chargedById,
        chargedByName: row.chargedByName,
        operatorName: row.operatorName,
      };
      // En SQL, en la misma transacción que la fila bloqueada (como el registro de los cobros).
      await tx.$executeRaw`
        INSERT INTO audit_events ("tenantId", "actorId", action, "targetType", "targetId", payload, "occurredAt")
        VALUES (${tenantId}::uuid, ${operatorId}::uuid, ${SERVICE_DISPUTED_ACTION}, 'OperatorEarning', ${earningId},
                ${JSON.stringify(payload)}::jsonb, now())
      `;
      return { reported: true as const };
    });
  }

  /**
   * «Mis cobros» de la app de la chica de antes (la de ahora usa
   * /staff/me/cobros): los suyos del local, los `limit` últimos, un cobro =
   * una fila (my-payments.ts). Dentro de una transacción con el local a mano:
   * wallet_charge_requests y wallet_consumptions tienen FORCE RLS.
   */
  async getMyPayments(operatorId: string, tenantId: string, limit = 50): Promise<MyPaymentRow[]> {
    return this.prisma.asSystem(async (tx) => {
      const cards = await tx.payment.findMany({
        where: { AND: [{ createdByUserId: operatorId, tenantId }, NOT_SALDO_TWIN] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: {
          id: true,
          amountCents: true,
          currency: true,
          status: true,
          provider: true,
          createdAt: true,
          qrToken: true,
          qrExpiresAt: true,
        },
      });
      const saldo = await saldoCharges(tx, { tenantId, requestedByUserId: operatorId }, limit);
      return myPaymentsPage(cards, saldo, limit);
    });
  }

  /** Sus últimos `limit` pagos (la app de antes y el panel). */
  async getMyPayouts(
    operatorId: string,
    tenantId: string,
    limit = 50,
  ): Promise<PayoutView[]> {
    return this.payoutRows(operatorId, tenantId, limit, null);
  }

  /** «Pagos recibidos» de la app: por páginas y entre dos fechas, con su justificante. */
  async myPayoutsPage(operatorId: string, tenantId: string, q: OwnHistoryQuery): Promise<OwnHistoryPage<PayoutView>> {
    return historyPage(await this.payoutRows(operatorId, tenantId, q.limit + 1, historyRange(q)), q.limit);
  }

  private async payoutRows(operatorId: string, tenantId: string, take: number, range: HistoryRange | null): Promise<PayoutView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<
      Array<{
        id: string;
        totalCents: number;
        paidByEmail: string | null;
        notes: string | null;
        earningCount: bigint;
        createdAt: Date;
        externalTxId: string | null;
        externalRail: string | null;
        reconciliationStatus: string;
        receiptUrl: string | null;
        reconciledAt: Date | null;
      }>
    >`
      SELECT po.id, po."totalCents", u.email AS "paidByEmail", po.notes,
             COALESCE(ec.cnt, 0)::bigint AS "earningCount",
             po."createdAt",
             po."externalTxId", po."externalRail", po."reconciliationStatus",
             po."receiptUrl", po."reconciledAt"
        FROM operator_payouts po
        LEFT JOIN users u ON u.id = po."paidByUserId"
        -- M3: JOIN agregado en lugar de subquery correlacionada por fila (N+1).
        LEFT JOIN (
          SELECT "payoutId", COUNT(*)::bigint AS cnt
            FROM operator_earnings
           WHERE "payoutId" IS NOT NULL
           GROUP BY "payoutId"
        ) ec ON ec."payoutId" = po.id
       WHERE po."operatorId" = ${operatorId}::uuid
         AND po."tenantId" = ${tenantId}::uuid
         ${historyWhere('po', range)}
       ORDER BY ${historyOrder('po', range)}
       LIMIT ${take}
    `);
    return rows.map((r) => ({
      id: r.id,
      totalCents: r.totalCents,
      paidByEmail: r.paidByEmail,
      notes: r.notes,
      earningCount: Number(r.earningCount),
      createdAt: r.createdAt.toISOString(),
      externalTxId: r.externalTxId,
      externalRail: (r.externalRail as PayoutView['externalRail']) ?? null,
      reconciliationStatus: (r.reconciliationStatus as PayoutView['reconciliationStatus']),
      receiptUrl: r.receiptUrl,
      reconciledAt: r.reconciledAt?.toISOString() ?? null,
    }));
  }

  /**
   * «Ganancias» de la chica: días de espera antes de pagar, su cuenta de
   * cobro (enmascarada) y las devoluciones que llegaron con el cobro ya
   * pagado (abiertas primero: se descuentan del próximo pago).
   */
  async getMyPayoutInfo(operatorId: string, tenantId: string, limit = 30): Promise<MyPayoutInfo> {
    const [user, debts] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: operatorId, tenantId },
        select: { ...PAYOUT_ACCOUNT_SELECT, oxiocardStatus: true, oxiocardStatusAt: true },
      }),
      this.prisma.asSystem((tx) => tx.$queryRaw<DebtRow[]>`
        SELECT r.id, e."paymentId", e."paymentAmountCents" AS "chargeCents",
               r."reversedDeltaCents" AS cents, r."createdAt" AS at, e."createdAt" AS "chargedAt",
               r."settledPayoutId", po."createdAt" AS "settledAt"
          FROM earning_reversals r
          JOIN operator_earnings e ON e.id = r."earningId"
          LEFT JOIN operator_payouts po ON po.id = r."settledPayoutId"
         WHERE e."operatorId" = ${operatorId}::uuid
           AND e."tenantId" = ${tenantId}::uuid
           AND r."afterPayout"
         ORDER BY (r."settledPayoutId" IS NULL) DESC, r."createdAt" DESC
         LIMIT ${limit}
      `),
    ]);
    return {
      holdDays: await this.holdDays(tenantId),
      account: payoutAccountView(user),
      debts: debts.map(debtView),
      // Su OxioCard (null: OXIOCARD_ENABLED apagado).
      oxiocard: user && this.oxiocardEnabled() ? oxiocardView(user) : null,
    };
  }

  // ─── Admin (OWNER/MANAGER del venue) ──────────────────────────────

  /** Las chicas del local (o los camareros: role WAITER) con su saldo. */
  async listVenueOperators(tenantId: string, role: PayeeRole = 'OPERATOR'): Promise<OperatorWithBalance[]> {
    const operators = await this.prisma.user.findMany({
      where: { tenantId, role, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const photos = await photoHashesOf(this.prisma, tenantId, operators.map((o) => o.id));
    // Su ficha NFC viva («Ficha nº 0522» en su hoja).
    const cards = await this.prisma.asSystem((tx) => liveStaffCards(tx, tenantId, operators.map((o) => o.id)));
    const result: OperatorWithBalance[] = [];
    for (const op of operators) {
      const balance = await this.getBalance(op.id, tenantId);
      result.push({
        ...this.toPublicView(op as never),
        photoHash: photos.get(op.id) ?? null,
        staffCard: cards.get(op.id) ?? null,
        balance,
      });
    }
    return result;
  }

  async createOperator(
    tenantId: string,
    actorUserId: string,
    dto: CreateOperatorDto,
    actorRole: Role,
  ): Promise<CreateOperatorResponse> {
    const email = dto.email.toLowerCase();
    const commission = commissionOnCreate(actorRole, dto.commissionBps);

    // Validar email único
    const existing = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({ where: { email } }),
    );
    if (existing) {
      throw new ConflictException(`Email ${email} ya está registrado`);
    }
    // Antes de crear nada: sin la dirección de la app no hay enlace de invitación.
    const baseUrl = this.operatorAppUrl();

    // Pre-generamos el userId para poder firmar el JWT antes de persistir y mantener
    // todo el alta en una sola transacción atómica (insert user + JWT con su id +
    // update con el hash del token de invite). Si algo falla, rollback completo.
    const userId = randomUUID();
    const placeholderHash = await placeholderPasswordHash();
    const inviteToken = await this.jwt.signAsync(
      { sub: userId, tenantId, purpose: 'operator-invite' } satisfies InviteJwtPayload,
      { expiresIn: `${INVITE_TTL_HOURS}h` },
    );
    const inviteTokenHash = hashInviteToken(inviteToken);

    const user = await this.prisma.$transaction(async (tx) => {
      return tx.user.create({
        data: {
          id: userId,
          tenantId,
          email,
          displayName: dto.displayName,
          passwordHash: placeholderHash,
          role: 'OPERATOR',
          commissionBps: commission.commissionBps,
          invitedAt: new Date(),
          inviteToken: inviteTokenHash,
        },
      });
    }).catch((err: unknown) => {
      // El correo es único en todo OxioPay y la comprobación de arriba solo ve este local: el de otro choca aquí (sin decir de cuál).
      throw isUniqueViolation(err) ? new ConflictException('Ese correo no se puede usar: prueba con otro.') : err;
    });

    const inviteUrl = `${baseUrl}/accept-invite?token=${inviteToken}`;

    // Intentar enviar email — si falla / NoOp, devolvemos URL al admin
    const venue = await this.prisma.venue.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    const html = `
      <h2>Bienvenida a ${escapeHtml(venue.name)}</h2>
      <p>Hola ${escapeHtml(dto.displayName)},</p>
      <p>Has sido añadida como operadora. Activa tu cuenta y crea tu contraseña en este enlace
      (válido durante ${INVITE_TTL_HOURS} h):</p>
      <p><a href="${inviteUrl}">Activar cuenta</a></p>
      <p>Si tienes problemas, copia este link en tu navegador:<br/>${inviteUrl}</p>
    `;
    const sent = await this.email.send({
      to: email,
      subject: `Activa tu cuenta en ${venue.name}`,
      html,
      text: `Activa tu cuenta: ${inviteUrl}`,
    });

    await this.audit.log({
      action: 'operator.created',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: user.id,
      payload: {
        email,
        displayName: dto.displayName,
        commissionBps: commission.commissionBps,
        commissionIgnored: commission.ignored,
        emailDelivered: sent.delivered,
      },
    });

    this.logger.log(
      `Operator created ${user.id} email=${email} venue=${tenantId} delivered=${sent.delivered}`,
    );

    return {
      operator: this.toPublicView(user),
      inviteUrl,
      emailSent: sent.delivered,
      ...(commission.ignored ? { notice: COMMISSION_OWNER_ONLY_NOTICE } : {}),
    };
  }

  async acceptInvite(token: string, password: string, birthDate?: string): Promise<{ ok: true }> {
    if (password.length < 8) {
      throw new BadRequestException('Password debe tener al menos 8 caracteres');
    }

    let decoded: InviteJwtPayload;
    try {
      decoded = await this.jwt.verifyAsync<InviteJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    if (decoded.purpose !== 'operator-invite') {
      throw new UnauthorizedException('Token con propósito incorrecto');
    }

    const user = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({
        where: { id: decoded.sub },
        select: { id: true, inviteToken: true, deletedAt: true, birthDate: true, role: true, displayName: true, invitedAt: true },
      }),
    );
    if (!user || user.deletedAt) {
      throw new NotFoundException('Operadora no encontrada');
    }
    // Comparamos hash sha256 del token contra el guardado (no guardamos el token en claro).
    const tokenHash = hashInviteToken(token);
    if (!user.inviteToken || user.inviteToken !== tokenHash) {
      throw new UnauthorizedException('Token ya utilizado o caducado');
    }
    // Una compañera no activa sin saber su edad: si no la dio en su alta, la pone aquí.
    // La guardada manda (la corrige el dueño en el panel). OxioParty: no hay
    // compañeras (el personal de las casetas activa como siempre).
    const needsBirthDate = user.role === 'OPERATOR' && !user.birthDate && !isPartyEdition();
    if (needsBirthDate && !birthDate) throw birthDateRequired();
    const newBirthDate = needsBirthDate && birthDate ? birthDateValue(birthDate) : null;
    if (minorNow(user.birthDate)) throw minorCannotActivate();
    if (newBirthDate && minorNow(newBirthDate)) {
      // Su invitación se anula (minorLockData) y el dueño lo ve en Incidencias.
      const lock = minorLockData(user, new Date(), await placeholderPasswordHash());
      await this.prisma.asSystem((tx) => tx.user.update({ where: { id: user.id }, data: { birthDate: newBirthDate, ...lock } }));
      await this.minorBlocked(decoded.tenantId, user, user.id, 'invitacion');
      throw minorCannotActivate();
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.asSystem((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          invitedAt: null,
          inviteToken: null,
          ...(newBirthDate ? { birthDate: newBirthDate } : {}),
        },
      }),
    );

    await this.audit.log({
      action: 'operator.invite.accepted',
      tenantId: decoded.tenantId,
      actorId: user.id,
      targetType: 'User',
      targetId: user.id,
    });

    this.logger.log(`Operator invite accepted for user=${user.id}`);
    return { ok: true };
  }

  // ─── Admin password management ────────────────────────────────────
  //
  // Casos de uso:
  //   1. Chica perdió el invite link / nunca le llegó (email NoOp en prod)
  //      → admin regenera invite con TTL nuevo, copia URL, envía WhatsApp.
  //   2. Chica olvidó la contraseña ya activada
  //      → admin setea password directa O genera random, copia, envía WhatsApp.
  //      La chica debería cambiarla al loguear (TODO: forzar primer-login change).
  //
  // Resetear la contraseña cierra al momento todas sus sesiones (refresh y
  // tokens de acceso ya emitidos: RefreshTokenService.revokeAllForUser). Antes
  // los JWT seguían valiendo hasta caducar (1 h).

  /**
   * Genera un nuevo invite link para una operadora que aún no ha activado su
   * cuenta (o que la perdió). Rota el inviteToken anterior. TTL 24h.
   * Si la chica ya activó password (invitedAt=null), devuelve error — usar
   * resetPassword en su lugar.
   */
  async regenerateInvite(
    tenantId: string,
    operatorId: string,
    actorUserId: string,
  ): Promise<{ inviteUrl: string; expiresAt: string }> {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { id: true, email: true, deletedAt: true, invitedAt: true, birthDate: true },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');
    if (operator.deletedAt) throw new ConflictException('Operadora dada de baja');
    if (minorNow(operator.birthDate)) throw minorCannotActivate();
    if (!operator.invitedAt) {
      throw new ConflictException(
        'Esta operadora ya activó su contraseña. Usa "Resetear contraseña" en su lugar.',
      );
    }
    const baseUrl = this.operatorAppUrl();

    const inviteToken = await this.jwt.signAsync(
      { sub: operator.id, tenantId, purpose: 'operator-invite' } satisfies InviteJwtPayload,
      { expiresIn: `${INVITE_TTL_HOURS}h` },
    );
    const inviteTokenHash = hashInviteToken(inviteToken);

    await this.prisma.user.update({
      where: { id: operator.id },
      data: {
        inviteToken: inviteTokenHash,
        invitedAt: new Date(),
      },
    });

    const inviteUrl = `${baseUrl}/accept-invite?token=${inviteToken}`;
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    await this.audit.log({
      action: 'operator.invite.regenerated',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operator.id,
      payload: { ttlHours: INVITE_TTL_HOURS },
    });
    this.logger.log(`Invite regenerated for operator=${operator.id} by actor=${actorUserId}`);

    return { inviteUrl, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Resetea la contraseña de una operadora YA ACTIVADA. Admin pasa una
   * password explícita O nada (en cuyo caso se genera una random segura).
   * La password en claro SOLO se devuelve UNA vez en el response — admin
   * la copia y la envía por WhatsApp. NightPay no la persiste en claro.
   *
   * Si la chica todavía está en estado invite (invitedAt!=null), usar
   * regenerateInvite. Resetear pass directa sobre un usuario "pending"
   * cierra el flujo de invite — la chica nunca puso su propia password.
   */
  async resetPassword(
    tenantId: string,
    operatorId: string,
    actorUserId: string,
    explicitPassword: string | null,
  ): Promise<{ password: string; reset: true }> {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { id: true, email: true, deletedAt: true, birthDate: true },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');
    if (operator.deletedAt) throw new ConflictException('Operadora dada de baja');
    // Con contraseña se entra: es activar la cuenta.
    if (minorNow(operator.birthDate)) throw minorCannotActivate();

    // Si admin pasa password explícita, validar; si no, generar random segura.
    let password: string;
    if (explicitPassword) {
      if (explicitPassword.length < 8) {
        throw new BadRequestException('Password mínimo 8 caracteres');
      }
      password = explicitPassword;
    } else {
      // 12 chars alfanuméricos legibles (sin 0/O/l/I que se confunden).
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      const bytes = randomBytes(12);
      password = Array.from(bytes)
        .map((b) => alphabet[b % alphabet.length])
        .join('');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.user.update({
      where: { id: operator.id },
      data: {
        passwordHash,
        // Si estaba pendiente de invite, cerramos ese flujo.
        invitedAt: null,
        inviteToken: null,
      },
    });
    // Con la contraseña vieja no se sigue dentro: ni el refresh ni el token de acceso.
    await this.sessions.revokeAllForUser(operator.id);

    await this.audit.log({
      action: 'operator.password.reset',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operator.id,
      payload: { explicit: Boolean(explicitPassword) },
    });
    this.logger.log(
      `Password reset for operator=${operator.id} by actor=${actorUserId} explicit=${Boolean(explicitPassword)}`,
    );

    return { password, reset: true };
  }

  // ─── Self-onboarding (Phase 1A.2) ────────────────────────────────
  // Admin genera un link único 72h. Chica abre el link sin login → ve form
  // pre-rellenado con sus datos actuales → submite. Si no sabe manejar la
  // web, el admin sigue rellenando desde su tab Onboarding como hasta ahora.

  /**
   * Genera (o regenera) el link self-onboarding para una operadora.
   * Solo OWNER/MANAGER del venue. El JWT anterior queda inválido al rotar.
   */
  async createSelfOnboardingLink(
    tenantId: string,
    operatorId: string,
    actorUserId: string,
    actorRole: Role,
  ): Promise<SelfOnboardingLinkResponse> {
    // Solo con enlace del dueño puede la chica poner su primera cuenta de cobro:
    // un encargado no decide a dónde va su dinero (como en el PATCH).
    const payout = actorRole === 'OWNER';
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { id: true, email: true, deletedAt: true },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');
    if (operator.deletedAt) throw new ConflictException('Operadora dada de baja');
    const baseUrl = this.operatorAppUrl();

    const token = await this.jwt.signAsync(
      {
        sub: operator.id,
        tenantId,
        purpose: 'operator-self-onboarding',
        payout,
      } satisfies SelfOnboardingJwtPayload,
      { expiresIn: `${SELF_ONBOARDING_TTL_HOURS}h` },
    );
    const tokenHash = hashInviteToken(token);

    await this.prisma.user.update({
      where: { id: operator.id },
      data: { selfOnboardingToken: tokenHash },
    });

    const url = `${baseUrl}/onboarding/${token}`;
    const expiresAt = new Date(Date.now() + SELF_ONBOARDING_TTL_HOURS * 60 * 60 * 1000);

    await this.audit.log({
      action: 'operator.self_onboarding_link.created',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operator.id,
      payload: { ttlHours: SELF_ONBOARDING_TTL_HOURS, payoutAllowed: payout },
    });
    this.logger.log(
      `Self-onboarding link created for operator=${operator.id} by actor=${actorUserId}`,
    );

    return { url, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Validación + lectura del perfil actual para que la chica vea sus datos
   * pre-rellenados en el form. Sin auth — el token JWT es la cred.
   */
  async getSelfOnboardingProfile(token: string): Promise<SelfOnboardingProfile> {
    const { operator, payoutAllowed } = await this.validateSelfOnboardingToken(token);
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({
        where: { id: operator.tenantId },
        select: { name: true },
      }),
    );
    const u = operator as unknown as {
      email: string;
      displayName: string | null;
      phone: string | null;
      passportCountry: string | null;
      passportLast4: string | null;
      hasEmpadronamiento: boolean;
      hasNie: boolean;
      hasTie: boolean;
      walletProvider: string | null;
      walletStatus: string | null;
      walletTestPassed: boolean;
      needsHelpWallet: boolean;
      needsHelpDocs: boolean;
      onboardingNotes: string | null;
      payoutMethod: string | null;
      payoutAddress: string | null;
      payoutLabel: string | null;
    };
    return {
      displayName: u.displayName,
      email: u.email,
      phone: u.phone,
      passportCountry: u.passportCountry,
      passportLast4: u.passportLast4,
      hasEmpadronamiento: u.hasEmpadronamiento ?? false,
      hasNie: u.hasNie ?? false,
      hasTie: u.hasTie ?? false,
      walletProvider: u.walletProvider as SelfOnboardingProfile['walletProvider'],
      walletStatus: u.walletStatus as SelfOnboardingProfile['walletStatus'],
      walletTestPassed: u.walletTestPassed ?? false,
      needsHelpWallet: u.needsHelpWallet ?? false,
      needsHelpDocs: u.needsHelpDocs ?? false,
      onboardingNotes: u.onboardingNotes,
      payoutMethod: u.payoutMethod as SelfOnboardingProfile['payoutMethod'],
      // Nunca la cuenta entera (el enlace puede llegar a otras manos): tapada.
      payoutAddressMasked: maskedPayoutAccount(operator as unknown as StoredPayoutAccount).addressMasked,
      payoutLabel: u.payoutLabel,
      venueName: venue.name,
      canSetPayout: payoutAllowed && !hasPayoutRouting(u),
      // Lo ya guardado, sin enseñarlo entero (el enlace puede llegar a otras manos).
      legalNameMasked: legalNameView(operator).masked,
      hasBirthDate: operator.birthDate !== null,
      oxiocardEnabled: this.oxiocardEnabled(),
      oxiocardStatus: operator.oxiocardStatus as OxiocardStatus,
    };
  }

  /**
   * La chica submite su form. Validamos token, actualizamos datos, e
   * INVALIDAMOS el token (single-use). Si la chica necesita editar más tarde,
   * el admin regenera un link nuevo.
   *
   * Antes el token quedaba activo 72h reutilizable — vector: link interceptado
   * permitía a un atacante cambiar payoutAddress hasta 72h. Ahora single-use.
   * El token usado queda marcado (self-onboarding-token.ts): el mismo enlace
   * otra vez da 409 «ya se guardaron tus datos», no «Token inválido».
   */
  async submitSelfOnboarding(
    token: string,
    dto: SelfOnboardingSubmitDto,
  ): Promise<{ ok: true; payoutIgnored?: 'existing' | 'owner_required'; minor?: true }> {
    const { operator, payoutAllowed, decoded, tokenHash } = await this.validateSelfOnboardingToken(token);
    const now = new Date();

    const data: Record<string, unknown> = {};
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.passportCountry !== undefined) data.passportCountry = dto.passportCountry;
    if (dto.passportLast4 !== undefined) data.passportLast4 = dto.passportLast4;
    if (dto.hasEmpadronamiento !== undefined) data.hasEmpadronamiento = dto.hasEmpadronamiento;
    if (dto.hasNie !== undefined) data.hasNie = dto.hasNie;
    if (dto.hasTie !== undefined) data.hasTie = dto.hasTie;
    if (dto.walletProvider !== undefined) data.walletProvider = dto.walletProvider;
    if (dto.walletStatus !== undefined) data.walletStatus = dto.walletStatus;
    if (dto.walletTestPassed !== undefined) {
      data.walletTestPassed = dto.walletTestPassed;
      data.walletTestAt = dto.walletTestPassed ? new Date() : null;
    }
    if (dto.needsHelpWallet !== undefined) data.needsHelpWallet = dto.needsHelpWallet;
    if (dto.needsHelpDocs !== undefined) data.needsHelpDocs = dto.needsHelpDocs;
    if (dto.onboardingNotes !== undefined) data.onboardingNotes = dto.onboardingNotes;
    // Su nombre legal (cifrado) y su fecha de nacimiento, solo si aún no estaban: lo
    // guardado decide si activa la cuenta y a quién se le paga, y lo corrige el dueño
    // en el panel (el enlace puede llegar a otras manos). «Abrir mi OxioCard».
    const identityIgnored = (['legalName', 'birthDate'] as const).filter((k) => dto[k] !== undefined && Boolean(operator[k]));
    const legalName = operator.legalName ? undefined : dto.legalName;
    const birthDate = operator.birthDate ? undefined : dto.birthDate;
    if (legalName !== undefined) Object.assign(data, legalNameData(operator, legalName));
    if (birthDate !== undefined) data.birthDate = birthDateValue(birthDate);
    if (dto.oxiocard) Object.assign(data, this.oxiocardRequest(operator.oxiocardStatus, now));
    // A dónde va su dinero: solo la primera vez y solo con enlace del dueño.
    // Si ya tiene cuenta, o el enlace lo generó un encargado, no se toca: queda
    // como propuesta en el registro y la pone el dueño desde el panel.
    const existing = operator as unknown as { payoutMethod?: string | null; payoutAddress?: string | null };
    const wantsPayout =
      dto.payoutMethod !== undefined || dto.payoutAddress !== undefined || dto.payoutLabel !== undefined;
    const payoutIgnored = !wantsPayout
      ? undefined
      : hasPayoutRouting(existing)
        ? ('existing' as const)
        : payoutAllowed
          ? undefined
          : ('owner_required' as const);
    // Su primera cuenta: cifrada y tapada aparte; los datos del banco (SWIFT) o
    // el titular (SEPA, obligatorio), según el método (los demás no llevan).
    let plan: PayoutAccountPlan | null = null;
    if (payoutIgnored) {
      this.logger.warn(`Self-onboarding ${(operator as { id: string }).id}: cuenta de cobro no aplicada (${payoutIgnored})`);
    } else if (wantsPayout) {
      plan = planPayoutAccountChange(
        operator as unknown as StoredPayoutAccount,
        { method: dto.payoutMethod, address: dto.payoutAddress, label: dto.payoutLabel, metadata: dto.payoutMetadata },
        new Date(),
      );
      Object.assign(data, plan.data);
    }

    // Marca progreso de onboarding automáticamente si todavía está NEW
    const current = operator as unknown as { onboardingStatus: string | null };
    if (current.onboardingStatus === 'NEW' || current.onboardingStatus === 'PROFILE_CREATED') {
      data.onboardingStatus = 'INVITE_ACTIVATED';
    }

    // Un solo uso: el enlace queda «usado» (ya no deja guardar ni leer; un
    // reintento con la respuesta perdida sabe que ya se guardó). La chica pide
    // al admin un enlace nuevo si quiere volver a editar. Solo si sigue siendo
    // el activo: dos «Guardar» a la vez no guardan dos veces.
    data.selfOnboardingToken = usedTokenMarker(tokenHash);
    // Menor de 18: no activa la cuenta (si ya entraba, deja de entrar) y se avisa al dueño.
    const minor = becomesMinor(operator.birthDate, birthDate, now);
    const lock = minor ? minorLockData(operator, now, await placeholderPasswordHash()) : {};

    // Ruta pública (sin local en el contexto): como la lectura del token, con asSystem.
    // shortcut: sin plan.ifUnchanged (el enlace solo pone la primera cuenta y es de un solo uso), añadirlo si un día deja cambiar una que ya existe.
    try {
      await this.prisma.asSystem((tx) =>
        tx.user.update({ where: { id: operator.id, selfOnboardingToken: tokenHash }, data: { ...data, ...lock } }),
      );
    } catch (err) {
      if (isRecordNotFound(err)) throw await this.goneSelfOnboardingToken(decoded, tokenHash);
      throw err;
    }

    await this.audit.log({
      action: 'operator.self_onboarding.submitted',
      tenantId: operator.tenantId,
      actorId: operator.id, // la propia chica es el actor
      targetType: 'User',
      targetId: operator.id,
      payload: {
        fields: Object.keys(data),
        tokenInvalidated: true,
        // La propuesta, tapada (el registro no lleva cuentas en claro).
        ...(payoutIgnored ? { payoutIgnored, proposedPayout: proposedPayoutForAudit(dto) } : {}),
        // Nombre legal o fecha que no se aplicaron (ya los había): solo el nombre del campo.
        ...(identityIgnored.length ? { identityIgnored } : {}),
      },
    });
    if (minor) await this.minorBlocked(operator.tenantId, operator, operator.id, 'enlace');
    if (plan?.accountChanged) {
      const holderName = legalName ?? legalNameView(operator).plain;
      await this.notifyPayoutChange({ tenantId: operator.tenantId, actorId: operator.id, via: 'enlace', operator: { ...operator, legalName: holderName }, plan });
    }

    this.logger.log(`Self-onboarding submitted by operator=${operator.id} (token invalidated)`);
    return { ok: true, ...(payoutIgnored ? { payoutIgnored } : {}), ...(minor ? { minor: true as const } : {}) };
  }

  /**
   * Valida el JWT + hash en DB. Devuelve el row del operator si OK.
   * Throws UnauthorizedException en cualquier fallo de validación — sin
   * detalles del motivo para no filtrar info a un atacante.
   */
  private async validateSelfOnboardingToken(token: string) {
    let decoded: SelfOnboardingJwtPayload;
    try {
      decoded = await this.jwt.verifyAsync<SelfOnboardingJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    if (decoded.purpose !== 'operator-self-onboarding') {
      throw new UnauthorizedException('Token inválido');
    }
    const tokenHash = hashInviteToken(token);
    const operator = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({
        where: {
          id: decoded.sub,
          tenantId: decoded.tenantId,
          role: 'OPERATOR',
          selfOnboardingToken: tokenHash,
          deletedAt: null,
        },
      }),
    );
    if (!operator) throw await this.goneSelfOnboardingToken(decoded, tokenHash);
    // Enlaces de antes (sin el dato) cuentan como de encargado.
    return { operator, payoutAllowed: decoded.payout === true, decoded, tokenHash };
  }

  /**
   * El enlace (bien firmado y sin caducar) ya no es el activo: si se usó para
   * guardar, 409 «ya se guardaron tus datos»; si no (el admin hizo otro), 401.
   */
  private async goneSelfOnboardingToken(decoded: SelfOnboardingJwtPayload, tokenHash: string): Promise<Error> {
    const used = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({
        where: {
          id: decoded.sub,
          tenantId: decoded.tenantId,
          role: 'OPERATOR',
          selfOnboardingToken: usedTokenMarker(tokenHash),
          deletedAt: null,
        },
        select: { id: true },
      }),
    );
    return used ? selfOnboardingAlreadySaved() : new UnauthorizedException('Token inválido o ya rotado');
  }

  /**
   * Campos que solo OWNER puede modificar — son de impacto financiero o legal:
   * - commissionBps: cambia el % que se lleva la chica de cada cobro
   * - active: dar de baja una chica
   * - payoutMethod/Address/Metadata/Label: a dónde va su dinero
   *
   * MANAGER puede tocar el resto (datos personales, onboarding, ayuda) que es
   * info operativa sin riesgo monetario directo.
   */
  private static readonly OWNER_ONLY_FIELDS = new Set<keyof UpdateOperatorDto>([
    'commissionBps',
    'active',
    'payoutMethod',
    'payoutAddress',
    'payoutMetadata',
    'payoutLabel',
    // Alta con tres caminos: deciden si activa la cuenta y a quién se le paga.
    'legalName',
    'birthDate',
    'payoutHolderConfirmed',
    'oxiocardStatus',
  ]);

  async updateOperator(
    tenantId: string,
    operatorId: string,
    actorUserId: string,
    actorRole: 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR',
    dto: UpdateOperatorDto,
  ): Promise<OperatorPublicView> {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');

    if (actorRole !== 'OWNER') {
      const attemptedOwnerFields = (Object.keys(dto) as Array<keyof UpdateOperatorDto>).filter(
        (k) => OperatorsService.OWNER_ONLY_FIELDS.has(k) && dto[k] !== undefined,
      );
      if (attemptedOwnerFields.length > 0) {
        throw new ForbiddenException(
          `Solo OWNER puede modificar: ${attemptedOwnerFields.join(', ')}`,
        );
      }
    }

    const data: Record<string, unknown> = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.commissionBps !== undefined) data.commissionBps = dto.commissionBps;
    if (dto.active !== undefined) {
      data.deletedAt = dto.active ? null : new Date();
    }
    // A dónde va su dinero: del método que queda, con titular en SEPA y SWIFT,
    // cifrada y tapada aparte; cambiarla para 48 h los pagos a la nueva.
    const plan = touchesPayoutAccount(dto)
      ? planPayoutAccountChange(
          operator as unknown as StoredPayoutAccount,
          { method: dto.payoutMethod, address: dto.payoutAddress, metadata: dto.payoutMetadata, label: dto.payoutLabel },
          new Date(),
        )
      : null;
    if (plan) Object.assign(data, plan.data);
    // Phase 1A.1 — Onboarding tracking
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.passportCountry !== undefined) data.passportCountry = dto.passportCountry;
    if (dto.passportLast4 !== undefined) data.passportLast4 = dto.passportLast4;
    if (dto.hasEmpadronamiento !== undefined) data.hasEmpadronamiento = dto.hasEmpadronamiento;
    if (dto.hasNie !== undefined) data.hasNie = dto.hasNie;
    if (dto.hasTie !== undefined) data.hasTie = dto.hasTie;
    if (dto.walletProvider !== undefined) data.walletProvider = dto.walletProvider;
    if (dto.walletStatus !== undefined) data.walletStatus = dto.walletStatus;
    if (dto.walletTestPassed !== undefined) {
      data.walletTestPassed = dto.walletTestPassed;
      data.walletTestAt = dto.walletTestPassed ? new Date() : null;
    }
    if (dto.needsHelpWallet !== undefined) data.needsHelpWallet = dto.needsHelpWallet;
    if (dto.needsHelpDocs !== undefined) data.needsHelpDocs = dto.needsHelpDocs;
    if (dto.onboardingStatus !== undefined) data.onboardingStatus = dto.onboardingStatus;
    if (dto.onboardingNotes !== undefined) data.onboardingNotes = dto.onboardingNotes;
    // Alta con tres caminos: nombre legal (cifrado), fecha de nacimiento, la
    // OxioCard a mano y «la cuenta es suya» (va al final: cambiar la cuenta o
    // el nombre en esta misma petición la borra antes).
    const now = new Date();
    if (dto.legalName !== undefined) Object.assign(data, legalNameData(operator, dto.legalName));
    if (dto.birthDate !== undefined) data.birthDate = birthDateValue(dto.birthDate);
    // Su documento, cifrado (o quitado); con la baja, se borra.
    if (dto.idDocument !== undefined) Object.assign(data, idDocumentData(operatorId, dto.idDocument));
    if (dto.active === false) Object.assign(data, idDocumentData(operatorId, null));
    if (dto.oxiocardStatus !== undefined) Object.assign(data, this.oxiocardStatusChange(operator.oxiocardStatus, dto.oxiocardStatus, now));
    if (dto.payoutHolderConfirmed) data.payoutHolderConfirmedAt = now;
    const minor = becomesMinor(operator.birthDate, dto.birthDate, now);
    const lock = minor ? minorLockData(operator, now, await placeholderPasswordHash()) : {};

    // Con cambio de cuenta, solo si sigue como se leyó: dos cambios a la vez no
    // se pisan (ni se saltan la espera, ni avisan con un «antes» que ya no era).
    // «La cuenta es suya» también: se confirma la que se leyó.
    // shortcut: no compara con la que vio el dueño en su pantalla, solo con la leída aquí; añadirlo si la consola de OxioPay cambia cuentas a menudo.
    const updated = await this.prisma.user
      .update({ where: { id: operatorId, ...plan?.ifUnchanged }, data: { ...data, ...lock } })
      .catch((err: unknown) => {
        throw plan && isRecordNotFound(err) ? payoutAccountChangedMeanwhile() : err;
      });
    if (minor) await this.minorBlocked(tenantId, operator, actorUserId, 'panel');
    // Baja: fuera al momento de la app (refresh y tokens de acceso ya emitidos).
    if (dto.active === false) await this.sessions.revokeAllForUser(operatorId);
    // Baja: su ficha NFC deja de valer.
    if (dto.active === false) await this.revokeStaffCardOnLeave(tenantId, operatorId, actorUserId);
    // Sale de las listas, pero se le sigue debiendo: que no se pierda de vista.
    if (dto.active === false && !operator.deletedAt) await this.flagLeftWithBalance(tenantId, operatorId, actorUserId, updated.displayName);

    const { totpCode: _code, ...changes } = dto;
    await this.audit.log({
      action: 'operator.updated',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operatorId,
      // La cuenta y el titular, tapados.
      payload: { changes: maskedChanges(changes, plan?.after.method ?? null) },
    });
    // A dónde va su dinero, con lo de antes (tapado): Incidencias, Telegram y a ella.
    if (plan?.accountChanged) {
      const legalName = dto.legalName ?? legalNameView(operator).plain;
      await this.notifyPayoutChange({ tenantId, actorId: actorUserId, via: 'panel', operator: { ...operator, legalName }, plan });
    }

    return this.toPublicView(updated);
  }

  /** Baja: su ficha NFC viva queda anulada (y en el registro). */
  private async revokeStaffCardOnLeave(tenantId: string, operatorId: string, actorUserId: string): Promise<void> {
    const number = await this.prisma.asSystem((tx) =>
      revokeLiveStaffCard(tx, { tenantId, userId: operatorId, byUserId: actorUserId, reason: 'offboarded' }),
    );
    if (number === null) return;
    await this.audit.log({
      action: 'operator.staff_card_revoked',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operatorId,
      payload: { number, reason: 'offboarded' },
    });
  }

  /**
   * Con menos de 18 años: su acceso ya quedó cerrado al guardar (minorLockData);
   * fuera también las sesiones abiertas, y el aviso al dueño (Incidencias y
   * Telegram), sin la fecha ni el nombre legal.
   */
  private async minorBlocked(
    tenantId: string,
    operator: { id: string; displayName: string | null; invitedAt: Date | null },
    actorId: string,
    via: 'panel' | 'enlace' | 'invitacion',
  ): Promise<void> {
    await this.sessions.revokeAllForUser(operator.id);
    await this.audit.log({
      action: 'operator.minor_blocked',
      tenantId,
      actorId,
      targetType: 'User',
      targetId: operator.id,
      payload: { via, name: operator.displayName?.trim() || null, wasActive: operator.invitedAt === null },
    });
    this.logger.warn(`Menor de edad: acceso cerrado a ${operator.id} (${via})`);
  }

  // ─── OxioCard (OXIOCARD_ENABLED, apagado de fábrica) ─────────────
  // Solo se apunta la petición y cómo va: ni documentos ni emisor. El estado
  // lo cambia a mano el dueño (o el super-admin, entrando en el local).

  private oxiocardEnabled(): boolean {
    const raw = this.config.get<boolean | string | undefined>('OXIOCARD_ENABLED');
    return raw === true || raw === 'true';
  }

  /** «Abrir mi OxioCard»: si no la había pedido, queda pedida; si ya, como está. */
  private oxiocardRequest(current: string, now: Date): Record<string, unknown> {
    if (!this.oxiocardEnabled()) throw new BadRequestException(OXIOCARD_OFF);
    return current === 'NO_SOLICITADA' ? { oxiocardStatus: 'SOLICITADA', oxiocardStatusAt: now } : {};
  }

  /** El dueño cambia el estado a mano. */
  private oxiocardStatusChange(current: string, next: OxiocardStatus, now: Date): Record<string, unknown> {
    if (!this.oxiocardEnabled()) throw new BadRequestException(OXIOCARD_OFF);
    return current === next ? {} : { oxiocardStatus: next, oxiocardStatusAt: now };
  }

  /** «Abrir mi OxioCard» desde su app. Sin OXIOCARD_ENABLED la ruta no existe (404). */
  async requestMyOxiocard(operatorId: string, tenantId: string): Promise<OxiocardView> {
    if (!this.oxiocardEnabled()) throw new NotFoundException();
    const now = new Date();
    // Solo si no la había pedido: pedirla dos veces (o a la vez) no cambia nada.
    const { count } = await this.prisma.user.updateMany({
      where: { id: operatorId, tenantId, role: 'OPERATOR', oxiocardStatus: 'NO_SOLICITADA' },
      data: { oxiocardStatus: 'SOLICITADA', oxiocardStatusAt: now },
    });
    if (count > 0) {
      await this.audit.log({
        action: 'operator.oxiocard_requested',
        tenantId,
        actorId: operatorId,
        targetType: 'User',
        targetId: operatorId,
        payload: { via: 'app' },
      });
    }
    const row = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { oxiocardStatus: true, oxiocardStatusAt: true },
    });
    if (!row) throw new NotFoundException('Compañera no encontrada');
    return oxiocardView(row);
  }

  /**
   * La cuenta de cobro de una compañera cambió: el registro (Incidencias lo
   * enseña y Telegram lo avisa) y un correo a ella. Su app se lo dice al
   * entrar (users.payoutAccountChangedAt; getPayoutNotice).
   */
  private async notifyPayoutChange(input: {
    tenantId: string;
    actorId: string;
    via: PayoutChangeVia;
    /** legalName en claro (si lo tiene): el titular se compara con él. */
    operator: { id: string; email: string; displayName: string | null; legalName: string | null };
    plan: PayoutAccountPlan;
  }): Promise<void> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: input.tenantId }, select: { name: true } }),
    );
    await notifyPayoutAccountChanged(
      { audit: this.audit, email: this.email, logger: this.logger },
      {
        tenantId: input.tenantId,
        actorId: input.actorId,
        via: input.via,
        operator: input.operator,
        venueName: venue.name,
        before: input.plan.before,
        after: input.plan.after,
        at: new Date(),
        holdUntil: input.plan.holdUntil,
      },
    );
  }

  /**
   * «Ver cuenta para pagar»: la cuenta entera (y el titular) para el dueño,
   * que ya ha pasado su 2FA en el controlador. Queda en el registro, tapada.
   */
  async revealPayoutAccount(tenantId: string, operatorId: string, actorUserId: string): Promise<PayoutAccountFull> {
    const row = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: PAYOUT_ACCOUNT_SELECT,
    });
    if (!row) throw new NotFoundException('Compañera no encontrada');
    let account: ReturnType<typeof openPayoutAccount>;
    try {
      account = openPayoutAccount(row);
    } catch (err) {
      this.logger.error(`No se puede abrir la cuenta de cobro de ${operatorId}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('No se puede leer la cuenta guardada: vuelve a ponerla en Editar.');
    }
    await this.audit.log({
      action: 'operator.payout_account_revealed',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operatorId,
      payload: accountForAudit(account),
    });
    return {
      userId: row.id,
      payoutMethod: account.method,
      payoutAddress: account.address,
      payoutLabel: account.label,
      payoutMetadata: account.metadata,
    };
  }

  /**
   * «Ver documento»: el DNI, NIE o pasaporte entero de la compañera para el
   * dueño, que ya ha pasado su 2FA en el controlador. Queda en el registro, tapado.
   */
  async revealIdDocument(tenantId: string, operatorId: string, actorUserId: string): Promise<IdDocumentFull> {
    const row = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { id: true, idDocumentType: true, idDocumentNumber: true },
    });
    if (!row) throw new NotFoundException('Compañera no encontrada');
    let doc: ReturnType<typeof openIdDocument>;
    try {
      doc = openIdDocument(row);
    } catch (err) {
      this.logger.error(`No se puede abrir el documento de ${operatorId}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('No se puede leer el documento guardado: vuelve a ponerlo en Onboarding.');
    }
    if (!doc) throw new NotFoundException('Aún no tiene el documento puesto');
    await this.audit.log({
      action: 'operator.id_document_revealed',
      tenantId,
      actorId: actorUserId,
      targetType: 'User',
      targetId: operatorId,
      payload: { type: doc.type, number: maskIdDocumentNumber(doc.number) },
    });
    return { userId: row.id, type: doc.type, number: doc.number };
  }

  /** «Tu cuenta de cobro ha cambiado» en su app: hasta que lo da por visto (tapada). */
  async getPayoutNotice(operatorId: string, tenantId: string): Promise<PayoutAccountNotice | null> {
    const row = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      select: { ...PAYOUT_ACCOUNT_SELECT, payoutNoticeSeenAt: true },
    });
    const changedAt = row?.payoutAccountChangedAt;
    if (!row || !changedAt) return null;
    if (row.payoutNoticeSeenAt && row.payoutNoticeSeenAt >= changedAt) return null;
    const masked = maskedPayoutAccount(row);
    return { changedAt: changedAt.toISOString(), method: masked.method, masked: masked.addressMasked };
  }

  /** «Entendido»: el aviso queda visto (solo el suyo). */
  async markPayoutNoticeSeen(operatorId: string, tenantId: string): Promise<{ ok: true }> {
    await this.prisma.user.updateMany({
      where: { id: operatorId, tenantId, role: 'OPERATOR' },
      data: { payoutNoticeSeenAt: new Date() },
    });
    return { ok: true };
  }

  private async flagLeftWithBalance(tenantId: string, operatorId: string, actorUserId: string, name: string | null): Promise<void> {
    try {
      const { pendingCents } = await this.getBalance(operatorId, tenantId);
      if (pendingCents <= 0) return;
      await this.audit.log({
        action: 'operator.left_with_balance',
        tenantId,
        actorId: actorUserId,
        targetType: 'User',
        targetId: operatorId,
        payload: { amountCents: pendingCents, name },
      });
    } catch (err) {
      // La baja ya está hecha y sus sesiones cerradas: un fallo aquí no la deshace.
      this.logger.error(`Baja de ${operatorId}: no se pudo comprobar lo que se le debe: ${(err as Error).message}`);
    }
  }

  async listOperatorEarnings(
    tenantId: string,
    operatorId: string,
    limit = 100,
  ): Promise<EarningView[]> {
    // Verificar que la operadora (o el camarero) pertenece a este venue (anti-IDOR)
    const exists = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: { in: [...PAYEE_ROLES] } },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Operadora no encontrada');
    return this.getMyEarnings(operatorId, tenantId, limit);
  }

  async listOperatorPayouts(
    tenantId: string,
    operatorId: string,
    limit = 100,
  ): Promise<PayoutView[]> {
    const exists = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: { in: [...PAYEE_ROLES] } },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Operadora no encontrada');
    return this.getMyPayouts(operatorId, tenantId, limit);
  }

  /**
   * Marca un payout para una operadora — agrupa todos los earnings sin
   * payoutId actual y los liquida atómicamente.
   * Si el neto agregado es <= 0 (ej. solo deudas pendientes) → 409.
   *
   * «Por aprobar»: con `exact` se pagan exactamente las comisiones y deudas que
   * fijó la petición y por ese total; si algo cambió (ya pagadas, devoluciones
   * nuevas…), 409 y no se apunta nada. `inTransaction` corre dentro de la
   * transacción, con el candado de la persona tomado y antes de leer lo que se
   * le paga (la aprobación se marca ahí; el pago directo comprueba que no haya
   * una petición pendiente); `afterCreate`, en la misma transacción, con el pago.
   * La cuenta de cobro y su espera de 48 h se leen también ahí dentro, con el
   * candado tomado: valen las de ese momento.
   * `expectedTotalCents`: si lo pagable ya no es lo que vio quien paga, 409
   * PAYOUT_CHANGED. `idempotency`: la misma clave y petición devuelven el pago
   * ya apuntado (comprobado con el candado de la chica tomado).
   */
  async createPayout(
    tenantId: string,
    operatorId: string,
    paidByUserId: string,
    notes?: string,
    options?: PayoutOptions,
  ) {
    // Que es del local (compañera o camarero): 404 sin abrir la transacción.
    const where = { id: operatorId, tenantId, role: { in: [...PAYEE_ROLES] } };
    if (!(await this.prisma.user.findFirst({ where }))) throw new NotFoundException('Operadora no encontrada');
    const holdDays = await this.holdDays(tenantId);

    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      await lockOperatorPayouts(tx, operatorId);
      // Su cuenta y su espera se leen aquí, con el candado ya tomado: las de
      // ahora, no las de antes de esperar el turno (un cambio de cuenta pudo
      // entrar mientras). La cuenta, como está guardada (cifrada): así va al
      // pago, para verificarlo on-chain.
      const operator = await tx.user.findFirst({
        where,
        select: {
          id: true,
          displayName: true,
          payoutMethod: true,
          payoutAddress: true,
          payoutHoldUntil: true,
          payoutMetadata: true,
          legalName: true,
          payoutHolderConfirmedAt: true,
        },
      });
      if (!operator) throw new NotFoundException('Operadora no encontrada');
      // Rail efectivo: el del dto si viene, sino el preferido de la persona.
      const rail = options?.externalRail ?? operator.payoutMethod ?? null;
      const idempotency = options?.idempotency;
      if (idempotency) {
        const replay = await replayPayout(tx, { tenantId, operatorId, paidByUserId, idempotency });
        if (replay) return { replay };
      }
      // Cuenta cambiada hace menos de 48 h, o con un titular que no coincide con
      // su nombre legal sin confirmar: a ella aún no (en efectivo, sí).
      const blocked = payoutAccountTooNew(operator, rail, new Date()) ?? payoutHolderNotConfirmed(operator, rail);
      if (blocked) throw blocked;
      await options?.inTransaction?.(tx);
      // Un hash on-chain solo vale para un pago del local.
      const txId = options?.externalTxId?.trim();
      if (txId && isAutoVerifiable(rail as PayoutMethod | null)) {
        const other = await otherPayoutWithTx(tx, tenantId, null, txId);
        if (other) throw txAlreadyUsed(other);
      }

      const { pending, debts } = options?.exact
        ? await exactSelection(tx, tenantId, operatorId, options.exact)
        : await payableSelection(tx, tenantId, operatorId, holdDays);
      const totalCents = payoutTotalCents(pending, debts);
      if (totalCents <= 0) {
        throw new ConflictException(
          `Saldo neto ${eur(totalCents)} — no hay nada que liquidar (la operadora arrastra deuda por devoluciones).`,
        );
      }
      if (options?.exact && totalCents !== options.exact.totalCents) {
        throw payoutChanged(`El saldo de la chica ha cambiado desde que se pidió (ahora ${eur(totalCents)}).`);
      }
      if (options?.expectedTotalCents !== undefined && totalCents !== options.expectedTotalCents) {
        throw payoutTotalChanged(totalCents, options.expectedTotalCents);
      }

      const payoutData = await this.payoutData({
        tenantId,
        operatorId,
        totalCents,
        paidByUserId,
        notes,
        rail,
        options,
        paidToAddress: operator.payoutAddress ?? null,
      });
      const payout = await tx.operatorPayout.create({ data: payoutData as never });
      await settleSelection(tx, payout.id, pending, debts);
      await options?.afterCreate?.(tx, payout.id);
      return { payout, count: pending.length };
    }).catch(async (err: unknown) => {
      if (!isUniqueViolation(err)) throw err;
      // Choque de único: Prisma no siempre dice qué índice fue (con FORCE RLS
      // Postgres esconde el detalle y llega «(not available)»). Se vuelve a
      // buscar la clave: el mismo pago → se devuelve; de otra chica, persona o
      // petición → 409 IDEMPOTENCY_KEY_REUSED (lo lanza replayPayout).
      const raced = options?.idempotency
        ? await this.findPayoutReplay(tenantId, operatorId, paidByUserId, options.idempotency)
        : null;
      if (raced) return { replay: raced };
      // Si no era la clave: otro pago se quedó el mismo hash (índice único parcial).
      throw txAlreadyUsed();
    });
    if ('replay' in result && result.replay) {
      this.logger.log(`Payout ${result.replay.id} repetido con la misma Idempotency-Key: no se apunta otra vez`);
      return result.replay;
    }

    await this.audit.log({
      action: 'operator.payout.created',
      tenantId,
      actorId: paidByUserId,
      targetType: 'User',
      targetId: operatorId,
      payload: {
        payoutId: result.payout.id,
        totalCents: result.payout.totalCents,
        earningCount: result.count,
        notes,
        ...(options?.approvalRequestId ? { approvalRequestId: options.approvalRequestId } : {}),
        ...(options?.batchKey ? { batchKey: options.batchKey } : {}),
      },
    });

    this.logger.log(
      `Payout ${result.payout.id} created operator=${operatorId} total=${result.payout.totalCents}c earnings=${result.count}`,
    );
    // «Te han pagado 37,50 €» a su móvil, sin esperar: el pago ya está apuntado.
    this.staffPush?.payoutMade({ tenantId, operatorId, payoutId: result.payout.id, totalCents: result.payout.totalCents });

    return {
      id: result.payout.id,
      totalCents: result.payout.totalCents,
      earningCount: result.count,
      createdAt: result.payout.createdAt.toISOString(),
    };
  }

  /**
   * El pago ya apuntado con esta Idempotency-Key por esta persona y para esta
   * chica (null si no hay; 409 si la clave es de otra petición). El controlador
   * lo mira antes de pedir el 2FA: repetir la petición no vuelve a pedirlo.
   */
  async findPayoutReplay(
    tenantId: string,
    operatorId: string,
    paidByUserId: string,
    idempotency: PayoutIdempotency,
  ): Promise<PayoutCreatedView | null> {
    return this.prisma.withTenant(tenantId, (tx) => replayPayout(tx, { tenantId, operatorId, paidByUserId, idempotency }));
  }

  /**
   * Datos del pago. Rail cripto → FX snapshot (Track sprint 2026-05-13 #15):
   * congelamos la tasa EUR↔USDT al crearlo; el verifier on-chain usará este
   * snapshot, no la tasa actual — evita falsos MISMATCH por volatilidad.
   */
  private async payoutData(input: {
    tenantId: string;
    operatorId: string;
    totalCents: number;
    paidByUserId: string;
    notes: string | undefined;
    rail: string | null;
    options: PayoutOptions | undefined;
    /** La dirección de cobro de la persona al pagarle (null = no tiene). */
    paidToAddress: string | null;
  }): Promise<Record<string, unknown>> {
    const { tenantId, operatorId, totalCents, paidByUserId, notes, rail, options } = input;
    // Se verifica on-chain contra esta, no contra la que tenga después ('' = no tenía).
    const data: Record<string, unknown> = {
      tenantId,
      operatorId,
      totalCents,
      paidByUserId,
      notes,
      paidToAddress: input.paidToAddress?.trim() ?? '',
    };
    if (options?.idempotency) {
      data.idempotencyKey = options.idempotency.key;
      data.idempotencyHash = options.idempotency.hash;
    }
    if (options?.externalTxId) data.externalTxId = options.externalTxId;
    if (rail) data.externalRail = rail;
    if (options?.receiptUrl) data.receiptUrl = options.receiptUrl;
    if (!rail || !OperatorsService.CRYPTO_RAILS.has(rail)) return data;
    try {
      const fx = await this.fxFactory.getEurToUsdtRateInfo();
      data.payoutFxRate = fx.rate.toFixed(6);
      data.expectedAmountUsdt = ((totalCents / 100) * fx.rate).toFixed(6);
      if (fx.degraded) {
        this.logger.warn(
          `Payout FX snapshot tomado en modo degraded (Binance API down) — payout=${operatorId} rate=${fx.rate} usando fallback`,
        );
      }
    } catch (err) {
      // Si falla el FX lookup, dejamos el payout sin snapshot (legacy mode)
      this.logger.error(
        `FX snapshot failed for operator=${operatorId}: ${(err as Error).message}. Payout creado sin snapshot.`,
      );
    }
    return data;
  }

  async ensureBelongsToVenue(operatorId: string, tenantId: string): Promise<void> {
    const exists = await this.prisma.user.findFirst({
      where: { id: operatorId, tenantId, role: { in: [...PAYEE_ROLES] } },
      select: { id: true },
    });
    if (!exists) throw new ForbiddenException('Operadora no pertenece a tu venue');
  }

  private toPublicView(user: {
    id: string;
    email: string;
    displayName: string | null;
    commissionBps: number | null;
    deletedAt: Date | null;
    invitedAt: Date | null;
    createdAt: Date;
  }): OperatorPublicView {
    const u = user as unknown as {
      id: string;
      email: string;
      displayName: string | null;
      commissionBps: number | null;
      deletedAt: Date | null;
      invitedAt: Date | null;
      createdAt: Date;
      payoutMethod?: string | null;
      payoutAddress?: string | null;
      payoutMetadata?: Record<string, unknown> | null;
      payoutLabel?: string | null;
      payoutAddressMasked?: string | null;
      payoutHolderMasked?: string | null;
      payoutAccountChangedAt?: Date | null;
      payoutHoldUntil?: Date | null;
      phone?: string | null;
      passportCountry?: string | null;
      passportLast4?: string | null;
      idDocumentType?: string | null;
      idDocumentNumber?: string | null;
      hasEmpadronamiento?: boolean;
      hasNie?: boolean;
      hasTie?: boolean;
      walletProvider?: string | null;
      walletStatus?: string | null;
      walletTestPassed?: boolean;
      walletTestAt?: Date | null;
      needsHelpWallet?: boolean;
      needsHelpDocs?: boolean;
      onboardingStatus?: string;
      onboardingNotes?: string | null;
      legalName?: string | null;
      birthDate?: Date | null;
      payoutHolderConfirmedAt?: Date | null;
      oxiocardStatus?: string;
      oxiocardStatusAt?: Date | null;
    };
    // El nombre legal, tapado; en claro solo para comparar con el titular.
    const legal = legalNameView(u);
    // La cuenta y el titular, siempre tapados (enteros: revealPayoutAccount).
    const stored: StoredPayoutAccount = {
      id: u.id,
      payoutMethod: u.payoutMethod ?? null,
      payoutAddress: u.payoutAddress ?? null,
      payoutMetadata: u.payoutMetadata ?? null,
      payoutLabel: u.payoutLabel ?? null,
      payoutAddressMasked: u.payoutAddressMasked,
      payoutHolderMasked: u.payoutHolderMasked,
    };
    const masked = maskedPayoutAccount(stored);
    const holdUntil = u.payoutHoldUntil && u.payoutHoldUntil.getTime() > Date.now() ? u.payoutHoldUntil : null;
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      commissionBps: u.commissionBps ?? 0,
      active: u.deletedAt === null,
      invitedAt: u.invitedAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      payoutMethod: masked.method,
      payoutAddressMasked: masked.addressMasked,
      payoutMetadata: masked.metadata,
      payoutHolderMasked: masked.holderMasked,
      payoutHolderMismatch: this.holderMismatch(stored, legal.plain ?? u.displayName),
      payoutHolderUnconfirmed: payoutHolderUnconfirmed({
        id: u.id,
        payoutMetadata: u.payoutMetadata ?? null,
        legalName: u.legalName ?? null,
        payoutHolderConfirmedAt: u.payoutHolderConfirmedAt ?? null,
      }),
      legalNameMasked: legal.masked,
      birthDate: birthDateOf(u.birthDate),
      ...(this.oxiocardEnabled()
        ? {
            oxiocardStatus: (u.oxiocardStatus ?? 'NO_SOLICITADA') as OxiocardStatus,
            oxiocardStatusAt: u.oxiocardStatusAt?.toISOString() ?? null,
          }
        : {}),
      payoutLabel: u.payoutLabel ?? null,
      payoutAccountChangedAt: u.payoutAccountChangedAt?.toISOString() ?? null,
      payoutHoldUntil: holdUntil?.toISOString() ?? null,
      phone: u.phone ?? null,
      passportCountry: u.passportCountry ?? null,
      passportLast4: u.passportLast4 ?? null,
      // Su documento, tapado (entero: revealIdDocument, el dueño con 2FA).
      ...idDocumentView(u),
      hasEmpadronamiento: u.hasEmpadronamiento ?? false,
      hasNie: u.hasNie ?? false,
      hasTie: u.hasTie ?? false,
      walletProvider: (u.walletProvider ?? null) as OperatorPublicView['walletProvider'],
      walletStatus: (u.walletStatus ?? null) as OperatorPublicView['walletStatus'],
      walletTestPassed: u.walletTestPassed ?? false,
      walletTestAt: u.walletTestAt?.toISOString() ?? null,
      needsHelpWallet: u.needsHelpWallet ?? false,
      needsHelpDocs: u.needsHelpDocs ?? false,
      onboardingStatus: (u.onboardingStatus ?? 'NEW') as OperatorPublicView['onboardingStatus'],
      onboardingNotes: u.onboardingNotes ?? null,
    };
  }

  /**
   * ¿El titular no se parece a su nombre? Aviso para el dueño (no bloquea).
   * Hay que abrir el titular: si no se puede (otra ENCRYPTION_KEK), sin aviso.
   */
  private holderMismatch(stored: StoredPayoutAccount, name: string | null): boolean {
    if (!(stored.payoutMetadata as PayoutMetadata | null)?.accountHolder) return false;
    try {
      return !holderMatchesName(openPayoutAccount(stored).metadata?.accountHolder, name);
    } catch (err) {
      this.logger.warn(`No se puede abrir el titular de ${stored.id}: ${(err as Error).message}`);
      return false;
    }
  }
}

/** Los cambios del panel para el registro: la cuenta, el titular y el nombre legal, tapados; la fecha de nacimiento, no va. */
function maskedChanges(changes: Omit<UpdateOperatorDto, 'totpCode'>, method: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { ...changes };
  if (changes.payoutAddress !== undefined) out.payoutAddress = maskPayoutAddress(method, changes.payoutAddress);
  if (changes.payoutMetadata) out.payoutMetadata = maskedMetadata(changes.payoutMetadata);
  if (changes.legalName !== undefined) out.legalName = maskHolderName(changes.legalName);
  if (changes.birthDate !== undefined) out.birthDate = 'cambiada';
  // El documento, nunca entero en el registro.
  if (changes.idDocument !== undefined) {
    out.idDocument = changes.idDocument ? { type: changes.idDocument.type, number: maskIdDocumentNumber(changes.idDocument.number) } : null;
  }
  return out;
}

function maskedMetadata(meta: PayoutMetadata): PayoutMetadata {
  return meta.accountHolder ? { ...meta, accountHolder: maskHolderName(meta.accountHolder) ?? undefined } : meta;
}

/** La cuenta que propuso la compañera (enlace de encargado, o ya tenía), tapada para el registro. */
function proposedPayoutForAudit(dto: SelfOnboardingSubmitDto): Record<string, unknown> {
  const method = dto.payoutMethod ?? null;
  const metadata = payoutMetadataFor(method, dto.payoutMetadata) ?? dto.payoutMetadata ?? null;
  return {
    method,
    address: maskPayoutAddress(method, dto.payoutAddress ?? null),
    label: dto.payoutLabel ?? null,
    ...(metadata ? { metadata: maskedMetadata(metadata) } : {}),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
