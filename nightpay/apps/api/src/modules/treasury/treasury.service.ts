import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PayoutVerifierFactory } from './payout-verifier.factory';
import {
  isAutoVerifiable,
  type VerifyResult,
} from './verifiers/payout-verifier.interface';
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

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(PayoutVerifierFactory) verifierFactory: PayoutVerifierFactory,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.verifierFactory = verifierFactory;
  }

  /**
   * Verifica un payout existente contra el rail externo.
   * - Si manualOverride=true → MANUAL_OK sin llamar al verifier.
   * - Si rail tiene verifier auto (cripto on-chain) → llama API blockchain.
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
    const payout = await this.prisma.asSystem((tx) =>
      tx.operatorPayout.findUnique({
        where: { id: payoutId },
        include: {
          operator: {
            select: {
              id: true,
              email: true,
              tenantId: true,
              payoutMethod: true,
              payoutAddress: true,
            },
          },
        },
      }),
    );
    if (!payout) throw new NotFoundException('Payout no encontrado');
    if (payout.tenantId !== tenantId) {
      throw new ForbiddenException('Payout no pertenece a tu venue');
    }

    // Idempotencia: si ya está reconciliado con el mismo txid no re-verifica.
    if (
      (payout.reconciliationStatus === 'MATCHED' ||
        payout.reconciliationStatus === 'MANUAL_OK') &&
      payout.externalTxId === dto.externalTxId
    ) {
      return {
        matched: true,
        status: payout.reconciliationStatus,
        occurredAt: payout.reconciledAt?.toISOString() ?? null,
        actualAmountCents: null,
        reason: 'already_reconciled',
      };
    }

    const op = payout.operator;

    let result: VerifyResult;
    if (dto.manualOverride) {
      result = {
        matched: true,
        status: 'MANUAL_OK',
        occurredAt: new Date(),
        actualAmountCents: null,
        reason: 'manual_override',
      };
    } else if (isAutoVerifiable(dto.externalRail)) {
      if (!op.payoutAddress) {
        throw new BadRequestException(
          'La operadora no tiene payoutAddress configurada — no se puede verificar on-chain',
        );
      }
      const verifier = this.verifierFactory.forMethod(dto.externalRail);
      result = await verifier.verify({
        externalTxId: dto.externalTxId,
        expectedToAddress: op.payoutAddress,
        expectedAmountCents: payout.totalCents,
      });
    } else {
      // Métodos manuales — guardamos la referencia y dejamos UNRECONCILED.
      // Admin debe llamar /confirm-manual aparte si quiere marcarlo MANUAL_OK.
      result = {
        matched: false,
        status: 'UNRECONCILED',
        occurredAt: null,
        actualAmountCents: null,
        reason: 'manual_required',
      };
    }

    const updateData: {
      externalTxId: string;
      externalRail: PayoutMethod;
      reconciliationStatus: typeof result.status;
      receiptUrl?: string;
      reconciledAt?: Date;
      reconciledByUserId?: string;
    } = {
      externalTxId: dto.externalTxId,
      externalRail: dto.externalRail,
      reconciliationStatus: result.status,
    };
    if (dto.receiptUrl) updateData.receiptUrl = dto.receiptUrl;
    if (result.matched) {
      updateData.reconciledAt = result.occurredAt ?? new Date();
      updateData.reconciledByUserId = actorUserId;
    }
    await this.prisma.asSystem((tx) =>
      tx.operatorPayout.update({
        where: { id: payoutId },
        data: updateData,
      }),
    );

    await this.audit.log({
      action: 'operator.payout.verified',
      tenantId,
      actorId: actorUserId,
      targetType: 'OperatorPayout',
      targetId: payoutId,
      payload: {
        externalRail: dto.externalRail,
        externalTxId: dto.externalTxId,
        matched: result.matched,
        status: result.status,
        reason: result.reason,
        manualOverride: dto.manualOverride ?? false,
      },
    });

    this.logger.log(
      `Payout ${payoutId} verify rail=${dto.externalRail} matched=${result.matched} status=${result.status} reason=${result.reason ?? '-'}`,
    );

    return {
      matched: result.matched,
      status: result.status,
      occurredAt: result.occurredAt?.toISOString() ?? null,
      actualAmountCents: result.actualAmountCents,
      reason: result.reason,
    };
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
    );

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

    const pendingRows = await this.prisma.$queryRaw<
      Array<{ pendingCents: bigint; operatorCount: bigint }>
    >`
      SELECT
        COALESCE(SUM("commissionCents" - "reversedCents"), 0)::bigint AS "pendingCents",
        COUNT(DISTINCT "operatorId")::bigint AS "operatorCount"
        FROM operator_earnings
       WHERE "tenantId" = ${tenantId}::uuid
         AND "payoutId" IS NULL
    `;

    const monthRows = await this.prisma.$queryRaw<
      Array<{ count: bigint; totalCents: bigint }>
    >`
      SELECT COUNT(*)::bigint AS count, COALESCE(SUM("totalCents"), 0)::bigint AS "totalCents"
        FROM operator_payouts
       WHERE "tenantId" = ${tenantId}::uuid
         AND "createdAt" >= ${firstOfMonth}
    `;

    const byMethodRows = await this.prisma.$queryRaw<
      Array<{ rail: string | null; count: bigint }>
    >`
      SELECT COALESCE("externalRail", 'UNSET') AS rail, COUNT(*)::bigint AS count
        FROM operator_payouts
       WHERE "tenantId" = ${tenantId}::uuid
       GROUP BY "externalRail"
    `;

    const byStatusRows = await this.prisma.$queryRaw<
      Array<{ status: string; count: bigint }>
    >`
      SELECT "reconciliationStatus" AS status, COUNT(*)::bigint AS count
        FROM operator_payouts
       WHERE "tenantId" = ${tenantId}::uuid
       GROUP BY "reconciliationStatus"
    `;

    return {
      pendingPayoutsCents: Number(pendingRows[0]?.pendingCents ?? 0),
      pendingOperatorCount: Number(pendingRows[0]?.operatorCount ?? 0),
      payoutsThisMonthCount: Number(monthRows[0]?.count ?? 0),
      payoutsThisMonthCents: Number(monthRows[0]?.totalCents ?? 0),
      byMethod: Object.fromEntries(byMethodRows.map((r) => [r.rail ?? 'UNSET', Number(r.count)])),
      byReconciliationStatus: Object.fromEntries(
        byStatusRows.map((r) => [r.status, Number(r.count)]),
      ),
    };
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
   * que un explorer lento/caído no bloquee el resto.
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
      const results = await Promise.allSettled(
        batch.map(async (p) => {
          const addr = p.operator.payoutAddress;
          const rail = p.externalRail as PayoutMethod | null;
          const txId = p.externalTxId;
          if (!addr || !rail || !txId) return { id: p.id, matched: false };
          const verifier = this.verifierFactory.forMethod(rail);
          const result = await verifier.verify({
            externalTxId: txId,
            expectedToAddress: addr,
            expectedAmountCents: p.totalCents,
          });
          if (result.matched) {
            await this.prisma.asSystem((tx) =>
              tx.operatorPayout.update({
                where: { id: p.id },
                data: {
                  reconciliationStatus: 'MATCHED',
                  reconciledAt: result.occurredAt ?? new Date(),
                },
              }),
            );
            return { id: p.id, matched: true };
          }
          return { id: p.id, matched: false };
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.matched) matched += 1;
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
}
