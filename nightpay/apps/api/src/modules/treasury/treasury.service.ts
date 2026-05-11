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
   */
  async verifyPayout(
    tenantId: string,
    payoutId: string,
    actorUserId: string,
    dto: VerifyPayoutDto,
  ): Promise<VerifyPayoutResult> {
    // Cargar payout + operadora (con asSystem para incluir verificación de tenant)
    const payout = await this.prisma.asSystem((tx) =>
      tx.operatorPayout.findUnique({
        where: { id: payoutId },
        include: {
          operator: {
            select: {
              id: true,
              email: true,
              tenantId: true,
              // @ts-expect-error - payout fields disponibles tras regenerate
              payoutMethod: true,
              // @ts-expect-error
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
    const op = payout.operator as unknown as {
      id: string;
      payoutMethod: PayoutMethod | null;
      payoutAddress: string | null;
    };

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

    // Persist
    const updateData: Record<string, unknown> = {
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
   */
  async confirmManual(
    tenantId: string,
    payoutId: string,
    actorUserId: string,
  ): Promise<{ ok: true }> {
    const payout = await this.prisma.asSystem((tx) =>
      tx.operatorPayout.findUnique({ where: { id: payoutId } }),
    );
    if (!payout) throw new NotFoundException('Payout no encontrado');
    if (payout.tenantId !== tenantId) {
      throw new ForbiddenException('Payout no pertenece a tu venue');
    }
    // @ts-expect-error - reconciliationStatus disponible tras regenerate
    const currentStatus = payout.reconciliationStatus as string;
    if (currentStatus === 'MATCHED') {
      throw new ConflictException('Payout ya está MATCHED (verificado on-chain)');
    }

    await this.prisma.asSystem((tx) =>
      tx.operatorPayout.update({
        where: { id: payoutId },
        data: {
          reconciliationStatus: 'MANUAL_OK',
          reconciledAt: new Date(),
          reconciledByUserId: actorUserId,
        } as Record<string, unknown>,
      }),
    );

    await this.audit.log({
      action: 'operator.payout.confirmed_manual',
      tenantId,
      actorId: actorUserId,
      targetType: 'OperatorPayout',
      targetId: payoutId,
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

    // Pending earnings (saldo pendiente agregado de chicas)
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

    // Payouts este mes
    const monthRows = await this.prisma.$queryRaw<
      Array<{ count: bigint; totalCents: bigint }>
    >`
      SELECT COUNT(*)::bigint AS count, COALESCE(SUM("totalCents"), 0)::bigint AS "totalCents"
        FROM operator_payouts
       WHERE "tenantId" = ${tenantId}::uuid
         AND "createdAt" >= ${firstOfMonth}
    `;

    // Split por externalRail
    const byMethodRows = await this.prisma.$queryRaw<
      Array<{ rail: string | null; count: bigint }>
    >`
      SELECT COALESCE("externalRail", 'UNSET') AS rail, COUNT(*)::bigint AS count
        FROM operator_payouts
       WHERE "tenantId" = ${tenantId}::uuid
       GROUP BY "externalRail"
    `;

    // Split por reconciliationStatus
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
   * Conversion rate EUR → USDT vía Binance público. Sirve para mostrar al admin
   * cuánto USDT necesita enviar para cubrir un payout EUR.
   */
  async getExchangeRate(): Promise<{ pair: string; rate: number; at: string }> {
    try {
      const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=EURUSDT', {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`binance ${res.status}`);
      const body = (await res.json()) as { price?: string };
      const rate = Number(body.price);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('invalid_rate');
      return { pair: 'EUR/USDT', rate, at: new Date().toISOString() };
    } catch (err) {
      this.logger.warn(`getExchangeRate fallback: ${(err as Error).message}`);
      return { pair: 'EUR/USDT', rate: 1.07, at: new Date().toISOString() };
    }
  }

  /**
   * Reconciliación nocturna: recorre payouts UNRECONCILED con externalTxId
   * + rail auto-verifiable y reintenta. Útil para casos donde el explorer
   * tardó en confirmar la primera vez.
   */
  async reconcilePending(tenantId: string): Promise<{ checked: number; matched: number }> {
    const pending = await this.prisma.asSystem((tx) =>
      tx.operatorPayout.findMany({
        where: {
          tenantId,
          // @ts-expect-error tras regenerate
          reconciliationStatus: 'UNRECONCILED',
          externalTxId: { not: null },
          externalRail: { in: ['USDT_TRC20', 'USDT_BEP20', 'USDC_POLY', 'USDC_SOL'] },
        } as Record<string, unknown>,
        include: {
          operator: { select: { payoutAddress: true } as Record<string, unknown> },
        },
      }),
    );

    let matched = 0;
    for (const p of pending) {
      const op = p.operator as unknown as { payoutAddress: string | null };
      const rail = (p as unknown as { externalRail: PayoutMethod | null }).externalRail;
      const txId = (p as unknown as { externalTxId: string | null }).externalTxId;
      if (!op.payoutAddress || !rail || !txId) continue;

      const verifier = this.verifierFactory.forMethod(rail);
      const result = await verifier.verify({
        externalTxId: txId,
        expectedToAddress: op.payoutAddress,
        expectedAmountCents: p.totalCents,
      });
      if (result.matched) {
        await this.prisma.asSystem((tx) =>
          tx.operatorPayout.update({
            where: { id: p.id },
            data: {
              reconciliationStatus: 'MATCHED',
              reconciledAt: result.occurredAt ?? new Date(),
            } as Record<string, unknown>,
          }),
        );
        matched += 1;
      }
    }
    this.logger.log(
      `reconcilePending tenant=${tenantId} checked=${pending.length} matched=${matched}`,
    );
    return { checked: pending.length, matched };
  }
}
