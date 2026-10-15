import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PayoutVerifierFactory } from './payout-verifier.factory';
import { parseHoldDays, payableSummary, payoutCutoff } from '../operators/payout-math';
import {
  isAutoVerifiable,
  type VerifyResult,
} from './verifiers/payout-verifier.interface';
import { checkTxTime, usdtToEurCents } from './verifiers/onchain-check';
import { isUniqueViolation, otherPayoutWithTx, txAlreadyUsed } from './payout-tx-guard';
import type {
  PayoutMethod,
  TreasuryStats,
  VerifyPayoutDto,
  VerifyPayoutResult,
} from '@nightpay/contracts';

const RECON_BATCH_SIZE = 5;
const RECON_MAX_PER_RUN = 100;

@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly verifierFactory: PayoutVerifierFactory;
  private readonly config: ConfigService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(PayoutVerifierFactory) verifierFactory: PayoutVerifierFactory,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.verifierFactory = verifierFactory;
    this.config = config;
  }

  /**
   * Verifica un payout existente contra el rail externo.
   * - Si manualOverride=true → MANUAL_OK sin llamar al verifier.
   * - Si rail tiene verifier auto (cripto on-chain) → llama API blockchain. El
   *   hash no puede estar en otro pago del local (409) y la transacción no
   *   puede ser de más de 24 h antes de apuntar el pago (MISMATCH).
   * - Si rail es manual (e-wallet, wire, etc.) → status UNRECONCILED, admin debe
   *   confirmar via /confirm-manual.
   * Idempotencia: si el payout ya está MATCHED/MANUAL_OK con el mismo externalTxId,
   * devuelve el resultado previo sin re-verificar.
   */
  async verifyPayout(
    tenantId: string,
    payoutId: string,
    actorUserId: string,
    dto: VerifyPayoutDto,
  ): Promise<VerifyPayoutResult> {
    const payout = await this.payoutToVerify(tenantId, payoutId);
    const req = { ...dto, externalTxId: dto.externalTxId.trim() };

    // Idempotencia: si ya está reconciliado con el mismo txid no re-verifica.
    if (
      (payout.reconciliationStatus === 'MATCHED' || payout.reconciliationStatus === 'MANUAL_OK') &&
      payout.externalTxId === req.externalTxId
    ) {
      return {
        matched: true,
        status: payout.reconciliationStatus,
        occurredAt: payout.reconciledAt?.toISOString() ?? null,
        actualAmountCents: null,
        reason: 'already_reconciled',
      };
    }
    if (isAutoVerifiable(req.externalRail) && !req.manualOverride) {
      const other = await this.prisma.asSystem((tx) => otherPayoutWithTx(tx, tenantId, payoutId, req.externalTxId));
      if (other) throw txAlreadyUsed(other);
    }

    const result = await this.runVerification(payout, req);
    await this.saveVerification(payoutId, actorUserId, req, result);
    await this.audit.log({
      action: 'operator.payout.verified',
      tenantId,
      actorId: actorUserId,
      targetType: 'OperatorPayout',
      targetId: payoutId,
      payload: {
        externalRail: req.externalRail,
        externalTxId: req.externalTxId,
        matched: result.matched,
        status: result.status,
        reason: result.reason,
        manualOverride: req.manualOverride ?? false,
      },
    });
    this.logger.log(
      `Payout ${payoutId} verify rail=${req.externalRail} matched=${result.matched} status=${result.status} reason=${result.reason ?? '-'}`,
    );
    const actualAmountUsdt = result.actualAmountUsdt ?? null;
    return {
      matched: result.matched,
      status: result.status,
      occurredAt: result.occurredAt?.toISOString() ?? null,
      actualAmountCents: result.actualAmountCents ?? usdtToEurCents(actualAmountUsdt, payout.payoutFxRate?.toString()),
      actualAmountUsdt,
      reason: result.reason,
    };
  }

  private async payoutToVerify(tenantId: string, payoutId: string) {
    const payout = await this.prisma.asSystem((tx) =>
      tx.operatorPayout.findUnique({
        where: { id: payoutId },
        include: {
          operator: {
            select: { id: true, email: true, tenantId: true, payoutMethod: true, payoutAddress: true },
          },
        },
      }),
    );
    if (!payout) throw new NotFoundException('Payout no encontrado');
    if (payout.tenantId !== tenantId) {
      throw new ForbiddenException('Payout no pertenece a tu venue');
    }
    return payout;
  }

  private async runVerification(
    payout: Awaited<ReturnType<TreasuryService['payoutToVerify']>>,
    req: VerifyPayoutDto,
  ): Promise<VerifyResult> {
    if (req.manualOverride) {
      return { matched: true, status: 'MANUAL_OK', occurredAt: new Date(), actualAmountCents: null, reason: 'manual_override' };
    }
    if (!isAutoVerifiable(req.externalRail)) {
      // Métodos manuales — guardamos la referencia y dejamos UNRECONCILED.
      // Admin debe llamar /confirm-manual aparte si quiere marcarlo MANUAL_OK.
      return { matched: false, status: 'UNRECONCILED', occurredAt: null, actualAmountCents: null, reason: 'manual_required' };
    }
    if (!payout.operator.payoutAddress) {
      throw new BadRequestException(
        'La operadora no tiene payoutAddress configurada — no se puede verificar on-chain',
      );
    }
    const verifier = this.verifierFactory.forMethod(req.externalRail);
    // FX snapshot persistido al crear el payout (Sprint 2026-05-13 fix #15).
    const result = await verifier.verify({
      externalTxId: req.externalTxId,
      expectedToAddress: payout.operator.payoutAddress,
      expectedAmountCents: payout.totalCents,
      expectedAmountUsdt: payout.expectedAmountUsdt ? Number(payout.expectedAmountUsdt.toString()) : undefined,
    });
    return checkTxTime(result, payout.createdAt);
  }

  private async saveVerification(
    payoutId: string,
    actorUserId: string,
    req: VerifyPayoutDto,
    result: VerifyResult,
  ): Promise<void> {
    const data = {
      externalTxId: req.externalTxId,
      externalRail: req.externalRail as PayoutMethod,
      reconciliationStatus: result.status,
      ...(req.receiptUrl ? { receiptUrl: req.receiptUrl } : {}),
      ...(result.matched ? { reconciledAt: result.occurredAt ?? new Date(), reconciledByUserId: actorUserId } : {}),
    };
    try {
      await this.prisma.asSystem((tx) => tx.operatorPayout.update({ where: { id: payoutId }, data }));
    } catch (err) {
      // Otro pago se quedó el mismo hash a la vez (índice único parcial).
      if (isUniqueViolation(err)) throw txAlreadyUsed();
      throw err;
    }
  }

  /**
   * Admin marca el payout como MANUAL_OK sin verificación on-chain.
   * Útil para rails que no tienen verifier auto (e-wallet, wire, cash).
   * Requiere al menos un artifact: externalTxId, receiptUrl o notes — sino no hay
   * trazabilidad y el audit log queda hueco.
   */
  async confirmManual(
    tenantId: string,
    payoutId: string,
    actorUserId: string,
    artifact: { externalTxId?: string; receiptUrl?: string; notes?: string },
  ): Promise<{ ok: true }> {
    const hasArtifact =
      (artifact.externalTxId && artifact.externalTxId.length >= 4) ||
      (artifact.receiptUrl && artifact.receiptUrl.length > 0) ||
      (artifact.notes && artifact.notes.trim().length > 0);
    if (!hasArtifact) {
      throw new BadRequestException(
        'confirm-manual requiere al menos un artifact: externalTxId, receiptUrl, o notes (trazabilidad audit).',
      );
    }

    const payout = await this.prisma.asSystem((tx) =>
      tx.operatorPayout.findUnique({ where: { id: payoutId } }),
    );
    if (!payout) throw new NotFoundException('Payout no encontrado');
    if (payout.tenantId !== tenantId) {
      throw new ForbiddenException('Payout no pertenece a tu venue');
    }
    if (payout.reconciliationStatus === 'MATCHED') {
      throw new ConflictException('Payout ya está MATCHED (verificado on-chain)');
    }
    if (payout.reconciliationStatus === 'MANUAL_OK') {
      // Idempotente: ya confirmado, no-op.
      return { ok: true };
    }

    await this.prisma.asSystem((tx) =>
      tx.operatorPayout.update({
        where: { id: payoutId },
        data: {
          reconciliationStatus: 'MANUAL_OK',
          reconciledAt: new Date(),
          reconciledByUserId: actorUserId,
          ...(artifact.externalTxId ? { externalTxId: artifact.externalTxId } : {}),
          ...(artifact.receiptUrl ? { receiptUrl: artifact.receiptUrl } : {}),
          ...(artifact.notes ? { notes: artifact.notes } : {}),
        },
      }),
    ).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw txAlreadyUsed();
      throw err;
    });

    await this.audit.log({
      action: 'operator.payout.confirmed_manual',
      tenantId,
      actorId: actorUserId,
      targetType: 'OperatorPayout',
      targetId: payoutId,
      payload: {
        hasExternalTxId: Boolean(artifact.externalTxId),
        hasReceiptUrl: Boolean(artifact.receiptUrl),
        hasNotes: Boolean(artifact.notes),
      },
    });
    return { ok: true };
  }

  /**
   * Estadísticas treasury para tab admin.
   */
  async getStats(tenantId: string): Promise<TreasuryStats> {
    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    firstOfMonth.setHours(0, 0, 0, 0);

    const pending = payableSummary(await this.operatorBalances(tenantId));

    const monthRows = await this.prisma.asSystem((tx) => tx.$queryRaw<
      Array<{ count: bigint; totalCents: bigint }>
    >`
      SELECT COUNT(*)::bigint AS count, COALESCE(SUM("totalCents"), 0)::bigint AS "totalCents"
        FROM operator_payouts
       WHERE "tenantId" = ${tenantId}::uuid
         AND "createdAt" >= ${firstOfMonth}
    `);

    const byMethodRows = await this.prisma.asSystem((tx) => tx.$queryRaw<
      Array<{ rail: string | null; count: bigint }>
    >`
      SELECT COALESCE("externalRail", 'UNSET') AS rail, COUNT(*)::bigint AS count
        FROM operator_payouts
       WHERE "tenantId" = ${tenantId}::uuid
       GROUP BY "externalRail"
    `);

    const byStatusRows = await this.prisma.asSystem((tx) => tx.$queryRaw<
      Array<{ status: string; count: bigint }>
    >`
      SELECT "reconciliationStatus" AS status, COUNT(*)::bigint AS count
        FROM operator_payouts
       WHERE "tenantId" = ${tenantId}::uuid
       GROUP BY "reconciliationStatus"
    `);

    return {
      pendingPayoutsCents: pending.payableCents,
      pendingOperatorCount: pending.operatorCount,
      heldPayoutsCents: pending.heldCents,
      operatorDebtCents: pending.debtCents,
      payoutsThisMonthCount: Number(monthRows[0]?.count ?? 0),
      payoutsThisMonthCents: Number(monthRows[0]?.totalCents ?? 0),
      byMethod: Object.fromEntries(byMethodRows.map((r) => [r.rail ?? 'UNSET', Number(r.count)])),
      byReconciliationStatus: Object.fromEntries(
        byStatusRows.map((r) => [r.status, Number(r.count)]),
      ),
    };
  }

  /**
   * Saldo de cada chica del local con la misma cuenta que OperatorsService.
   * getBalance y createPayout: comisión + propina − devuelto de lo no pagado,
   * lo que sigue en espera (PAYOUT_HOLD_DAYS) y la deuda por devoluciones
   * llegadas con la comisión ya pagada.
   */
  private async operatorBalances(tenantId: string) {
    const cutoff = payoutCutoff(new Date(), parseHoldDays(this.config.get('PAYOUT_HOLD_DAYS')));
    const rows = await this.prisma.asSystem((tx) => tx.$queryRaw<
      Array<{ operatorId: string; unpaidCents: bigint; heldCents: bigint; debtCents: bigint }>
    >`
      SELECT o."operatorId",
             COALESCE(u."unpaidCents", 0)::bigint AS "unpaidCents",
             COALESCE(u."heldCents", 0)::bigint AS "heldCents",
             COALESCE(d."debtCents", 0)::bigint AS "debtCents"
        FROM (SELECT DISTINCT "operatorId" FROM operator_earnings WHERE "tenantId" = ${tenantId}::uuid) o
        LEFT JOIN (
          SELECT "operatorId",
                 SUM("commissionCents" + COALESCE("tipCents", 0) - "reversedCents") AS "unpaidCents",
                 SUM(CASE WHEN "createdAt" > ${cutoff}
                          THEN "commissionCents" + COALESCE("tipCents", 0) - "reversedCents" ELSE 0 END) AS "heldCents"
            FROM operator_earnings
           WHERE "tenantId" = ${tenantId}::uuid
             AND "payoutId" IS NULL
           GROUP BY "operatorId"
        ) u ON u."operatorId" = o."operatorId"
        LEFT JOIN (
          SELECT e."operatorId", SUM(r."reversedDeltaCents") AS "debtCents"
            FROM earning_reversals r
            JOIN operator_earnings e ON e.id = r."earningId"
           WHERE e."tenantId" = ${tenantId}::uuid
             AND r."afterPayout"
             AND r."settledPayoutId" IS NULL
           GROUP BY e."operatorId"
        ) d ON d."operatorId" = o."operatorId"
    `);
    return rows.map((r) => ({
      unpaidCents: Number(r.unpaidCents),
      heldCents: Number(r.heldCents),
      debtCents: Number(r.debtCents),
    }));
  }

  /**
   * Conversion rate EUR → USDT vía Binance público.
   * Delega al factory que gestiona caché + fallback + flag degraded.
   */
  async getExchangeRate(): Promise<{ pair: string; rate: number; at: string; degraded: boolean }> {
    const { rate, degraded } = await this.verifierFactory.getEurToUsdtRateInfo();
    return {
      pair: 'EUR/USDT',
      rate,
      at: new Date().toISOString(),
      degraded,
    };
  }

  /**
   * Reconciliación nocturna: recorre payouts UNRECONCILED con externalTxId
   * + rail auto-verifiable y reintenta. Procesa en batches con allSettled para
   * que un explorer lento/caído no bloquee el resto. Mismas reglas que
   * verifyPayout: hash de un solo pago y transacción no anterior al pago.
   */
  async reconcilePending(tenantId: string): Promise<{ checked: number; matched: number }> {
    const pending = await this.prisma.asSystem((tx) =>
      tx.operatorPayout.findMany({
        where: {
          tenantId,
          reconciliationStatus: 'UNRECONCILED',
          externalTxId: { not: null },
          externalRail: { in: ['USDT_TRC20', 'USDT_BEP20', 'USDC_POLY', 'USDC_SOL'] },
        },
        include: {
          operator: { select: { payoutAddress: true } },
        },
        take: RECON_MAX_PER_RUN,
        orderBy: { createdAt: 'asc' },
      }),
    );

    let matched = 0;
    for (let i = 0; i < pending.length; i += RECON_BATCH_SIZE) {
      const batch = pending.slice(i, i + RECON_BATCH_SIZE);
      const results = await Promise.allSettled(batch.map((p) => this.reconcileOne(p)));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) matched += 1;
        if (r.status === 'rejected') {
          this.logger.warn(`recon batch item rejected: ${(r.reason as Error).message}`);
        }
      }
    }
    this.logger.log(
      `reconcilePending tenant=${tenantId} checked=${pending.length} matched=${matched}`,
    );
    return { checked: pending.length, matched };
  }

  /** true si quedó MATCHED. */
  private async reconcileOne(p: {
    id: string;
    tenantId: string;
    totalCents: number;
    createdAt: Date;
    externalRail: string | null;
    externalTxId: string | null;
    expectedAmountUsdt: { toString(): string } | null;
    operator: { payoutAddress: string | null };
  }): Promise<boolean> {
    const addr = p.operator.payoutAddress;
    const rail = p.externalRail as PayoutMethod | null;
    const txId = p.externalTxId?.trim();
    if (!addr || !rail || !txId) return false;
    const other = await this.prisma.asSystem((tx) => otherPayoutWithTx(tx, p.tenantId, p.id, txId));
    if (other) {
      this.logger.warn(`recon: payout ${p.id} comparte hash con ${other.id} — no se concilia solo`);
      return false;
    }
    // FX snapshot persistido al crear el payout — uso exacto para evitar
    // falsos MISMATCH por volatilidad EUR↔USDT entre creación y verify.
    const raw = await this.verifierFactory.forMethod(rail).verify({
      externalTxId: txId,
      expectedToAddress: addr,
      expectedAmountCents: p.totalCents,
      expectedAmountUsdt: p.expectedAmountUsdt ? Number(p.expectedAmountUsdt.toString()) : undefined,
    });
    const result = checkTxTime(raw, p.createdAt);
    if (!result.matched) return false;
    await this.prisma.asSystem((tx) =>
      tx.operatorPayout.update({
        where: { id: p.id },
        data: { reconciliationStatus: 'MATCHED', reconciledAt: result.occurredAt ?? new Date() },
      }),
    );
    return true;
  }
}
