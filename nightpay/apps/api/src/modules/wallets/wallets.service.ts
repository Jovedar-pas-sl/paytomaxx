import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
// IMPORTANT: importar solo el TIPO de RefundsService — el value se resuelve
// vía ModuleRef en runtime con string token. Esto evita el ciclo de imports
// Wallets→Refunds→Payments→Wallets que bloqueaba el bootstrap de Nest.
import type { RefundsService } from '../refunds/refunds.service';
import type { Role } from '@nightpay/contracts';
import type {
  ClientWalletView,
  ConsumeWalletDto,
  ConsumeWalletResult,
  RefundWalletDto,
  RefundWalletResult,
  WalletsAdminStats,
} from '@nightpay/contracts';

/** Generador del qrToken — base64url 18 bytes ≈ 24 chars, suficientemente único. */
function generateQrToken(): string {
  return randomBytes(18).toString('base64url');
}

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly moduleRef: ModuleRef;
  // Cache lazy: resolvemos RefundsService en la primera llamada a refund CARD,
  // NO durante bootstrap (evita bloqueo de DI ante ciclo Wallets→Refunds→Payments→Wallets).
  private refundsService: RefundsService | null = null;
  private refundsResolved = false;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ModuleRef) moduleRef: ModuleRef,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.moduleRef = moduleRef;
  }

  /**
   * Lazy resolver — se llama en primera invocación que necesite RefundsService.
   * Usamos string token ('RefundsService') porque importar la clase como value
   * causa ciclo Wallets→Refunds→Payments→Wallets que bloquea bootstrap.
   * NestJS registra los providers por className por defecto, así que el
   * string 'RefundsService' funciona como token de resolución.
   */
  private getRefundsService(): RefundsService | null {
    if (this.refundsResolved) return this.refundsService;
    this.refundsResolved = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.refundsService = this.moduleRef.get('RefundsService' as any, { strict: false });
    } catch {
      this.logger.warn('RefundsService no resoluble — wallet refund CARD caerá a modo DB-only');
      this.refundsService = null;
    }
    return this.refundsService;
  }

  /**
   * Crea una ClientWallet con balance=0. Llamado desde payments.service cuando
   * un POST /payments incluye {wallet:{create:true}}. El balance se suma cuando
   * el Payment del top-up transita a AUTHORIZED.
   */
  async createEmpty(input: {
    tenantId: string;
    identifier?: string | null;
  }): Promise<{ id: string; qrToken: string }> {
    const wallet = await this.prisma.asSystem((tx) =>
      tx.clientWallet.create({
        data: {
          tenantId: input.tenantId,
          identifier: input.identifier ?? null,
          qrToken: generateQrToken(),
        },
        select: { id: true, qrToken: true },
      }),
    );
    this.logger.log(
      `Wallet created id=${wallet.id} tenant=${input.tenantId} identifier=${input.identifier ?? '-'}`,
    );
    return wallet;
  }

  /**
   * Suma `amountCents` al balance de una wallet. Llamado por payments.service
   * cuando un Payment con walletId transita a AUTHORIZED. Atómico (SELECT FOR
   * UPDATE) para evitar lost updates si dos webhooks llegan a la vez.
   */
  async creditFromTopUp(input: {
    tenantId: string;
    walletId: string;
    amountCents: number;
    paymentId: string;
  }): Promise<{ newBalanceCents: number }> {
    if (input.amountCents <= 0) {
      throw new BadRequestException('amountCents debe ser positivo');
    }
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ id: string; balanceCents: number; status: string; tenantId: string }>
      >`
        SELECT id, "balanceCents", status, "tenantId"
          FROM client_wallets
         WHERE id = ${input.walletId}::uuid
           FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException(`Wallet ${input.walletId} no encontrada`);
      }
      const w = locked[0]!;
      if (w.tenantId !== input.tenantId) {
        throw new ForbiddenException('Wallet no pertenece a tu venue');
      }
      if (w.status !== 'ACTIVE') {
        throw new ConflictException(`Wallet en status ${w.status} — no se puede recargar`);
      }
      const newBalance = w.balanceCents + input.amountCents;
      await tx.clientWallet.update({
        where: { id: input.walletId },
        data: { balanceCents: newBalance },
      });
      this.logger.log(
        `Wallet ${input.walletId} credited +${input.amountCents}c by payment ${input.paymentId}. balance=${newBalance}`,
      );
      return { newBalanceCents: newBalance };
    });
  }

  /**
   * Cobra contra el balance de la wallet. Atómico:
   *  1. SELECT FOR UPDATE del wallet
   *  2. valida balance suficiente + status ACTIVE
   *  3. crea WalletConsumption
   *  4. si providedBy.role=OPERATOR → crea OperatorEarning con snapshot bps
   *  5. UPDATE wallet.balanceCents
   *
   * Idempotency-Key obligatoria para evitar doble-cobro del camarero (UI puede
   * mandar 2 clicks). El unique constraint (tenantId, idempotencyKey) garantiza
   * que la 2da llamada falle con 409 y devolvamos el resultado original.
   */
  async consume(input: {
    tenantId: string;
    walletId: string;
    providedByUserId: string;
    idempotencyKey: string;
    dto: ConsumeWalletDto;
  }): Promise<ConsumeWalletResult> {
    // 0. Idempotency check rápido — si ya existe el consumption, devolvemos el resultado original.
    const existing = await this.prisma.asSystem((tx) =>
      tx.walletConsumption.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: {
          earning: { select: { id: true, commissionCents: true } },
          wallet: { select: { balanceCents: true } },
        },
      }),
    );
    if (existing) {
      return {
        consumptionId: existing.id,
        newBalanceCents: existing.wallet.balanceCents,
        earningCreated: existing.earning !== null,
        earningCommissionCents: existing.earning?.commissionCents ?? null,
      };
    }

    // Tip handling: default 'operator' si la providedBy es OPERATOR; si no, 'venue'.
    const tipCents = input.dto.tipCents ?? 0;
    const tipGoesTo = input.dto.tipGoesTo ?? null;

    return this.prisma.$transaction(async (tx) => {
      // 1. Lock wallet
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          balanceCents: number;
          status: string;
          tenantId: string;
        }>
      >`
        SELECT id, "balanceCents", status, "tenantId"
          FROM client_wallets
         WHERE id = ${input.walletId}::uuid
           FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException(`Wallet ${input.walletId} no encontrada`);
      }
      const w = locked[0]!;
      if (w.tenantId !== input.tenantId) {
        throw new ForbiddenException('Wallet no pertenece a tu venue');
      }
      if (w.status !== 'ACTIVE') {
        throw new ConflictException(`Wallet en status ${w.status} — no se puede cobrar`);
      }
      // El tip se descuenta también del balance (cliente pagó por adelantado todo).
      const totalDebit = input.dto.amountCents + tipCents;
      if (w.balanceCents < totalDebit) {
        throw new ConflictException(
          `Balance insuficiente: tiene ${(w.balanceCents / 100).toFixed(2)}€, ` +
            `intentas cobrar ${(input.dto.amountCents / 100).toFixed(2)}€` +
            (tipCents > 0 ? ` + propina ${(tipCents / 100).toFixed(2)}€` : ''),
        );
      }

      // 2. Lee role + commissionBps del provider (para decidir si hay earning)
      const provider = await tx.user.findFirst({
        where: { id: input.providedByUserId, tenantId: input.tenantId },
        select: { role: true, commissionBps: true },
      });
      if (!provider) {
        throw new ForbiddenException('Usuario no pertenece a este venue');
      }

      // 3. Crea consumption (con tip metadata).
      const effectiveTipGoesTo =
        tipCents > 0
          ? tipGoesTo ?? (provider.role === 'OPERATOR' ? 'operator' : 'venue')
          : null;
      const consumption = await tx.walletConsumption.create({
        data: {
          tenantId: input.tenantId,
          walletId: input.walletId,
          amountCents: input.dto.amountCents,
          providedByUserId: input.providedByUserId,
          category: input.dto.category,
          notes: input.dto.notes ?? null,
          idempotencyKey: input.idempotencyKey,
          tipCents,
          ...(effectiveTipGoesTo ? { tipGoesTo: effectiveTipGoesTo } : {}),
        },
      });

      // 4. Si es OPERATOR (chica), genera earning ligado al consumption.
      //    Math.round (no floor) evita bias unidireccional contra operadora.
      //    Tip se suma al earning solo si tipGoesTo='operator' (default cuando la
      //    chica cobra) o no se especifica.
      let earningCommissionCents: number | null = null;
      let earningTipCents = 0;
      if (provider.role === 'OPERATOR' && provider.commissionBps !== null) {
        const commissionCents = Math.round(
          (input.dto.amountCents * provider.commissionBps) / 10_000,
        );
        if (tipCents > 0 && effectiveTipGoesTo === 'operator') {
          earningTipCents = tipCents;
        }
        await tx.operatorEarning.create({
          data: {
            tenantId: input.tenantId,
            operatorId: input.providedByUserId,
            consumptionId: consumption.id,
            paymentAmountCents: input.dto.amountCents,
            commissionBps: provider.commissionBps,
            commissionCents,
            tipCents: earningTipCents,
          },
        });
        earningCommissionCents = commissionCents;
      }

      // 5. Decrement balance + marcar DEPLETED si llegó a 0
      const newBalance = w.balanceCents - totalDebit;
      await tx.clientWallet.update({
        where: { id: input.walletId },
        data: {
          balanceCents: newBalance,
          // Solo marcamos DEPLETED si llegó exactamente a 0 — el refund flow
          // se encarga del "wallet en uso con balance>0 al cierre".
          ...(newBalance === 0 ? { status: 'DEPLETED' } : {}),
        },
      });

      this.logger.log(
        `Wallet ${input.walletId} consumed -${input.dto.amountCents}c (tip ${tipCents}c) by ${input.providedByUserId} (${provider.role}) cat=${input.dto.category}. balance=${newBalance}`,
      );

      return {
        consumptionId: consumption.id,
        newBalanceCents: newBalance,
        earningCreated: earningCommissionCents !== null,
        earningCommissionCents,
        tipCents: earningTipCents,
      };
    });
  }

  /**
   * Refund del balance restante de una wallet.
   *  - method=CARD: REFUND REAL al PSP. Distribuye el balance entre los
   *    top-up Payments AUTHORIZED de esta wallet (más reciente primero, para
   *    minimizar riesgo de salir de la ventana de refund del PSP). Cada refund
   *    llama RefundsService.refund() que llama al adapter del provider real.
   *    Si UN refund falla, abortamos los siguientes y devolvemos el parcial.
   *  - method=CREDIT: extiende expiresAt 30 días y mantiene ACTIVE para próxima visita.
   *
   * Actor input: contiene userId + role + tenantId — necesarios para los
   * permission checks de RefundsService (rechaza WAITER, exige 2FA TOTP en
   * refunds >= 100€).
   */
  async refund(input: {
    tenantId: string;
    walletId: string;
    actor: { userId: string; role: Role; tenantId: string };
    dto: RefundWalletDto;
  }): Promise<RefundWalletResult> {
    // Para CREDIT seguimos en una sola transacción simple (no toca PSP).
    if (input.dto.method === 'CREDIT') {
      return this.refundCreditFlow(input);
    }
    // CARD: el flujo PSP NO puede ir dentro de una $transaction prolongada
    // porque RefundsService.refund() abre su propia transacción + llama HTTP
    // al adapter (puede tardar segundos). Manejo en dos pasos:
    //   1. Lock wallet + valida + lee top-ups (transacción corta)
    //   2. Llama refunds PSP secuencial fuera de transacción
    //   3. Marca wallet REFUNDED al final
    return this.refundCardFlow(input);
  }

  /** CREDIT: no toca PSP, transacción simple. */
  private async refundCreditFlow(input: {
    tenantId: string;
    walletId: string;
    actor: { userId: string };
    dto: RefundWalletDto;
  }): Promise<RefundWalletResult> {
    return this.prisma.$transaction(async (tx) => {
      const w = await this.lockAndValidate(tx, input.tenantId, input.walletId);
      const refundedCents = w.balanceCents;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await tx.clientWallet.update({
        where: { id: input.walletId },
        data: { expiresAt },
      });
      await this.audit.log({
        action: 'wallet.refund',
        tenantId: input.tenantId,
        actorId: input.actor.userId,
        targetType: 'ClientWallet',
        targetId: input.walletId,
        payload: { method: 'CREDIT', refundedCents, notes: input.dto.notes },
      });
      return {
        walletId: input.walletId,
        method: 'CREDIT',
        refundedCents,
        newStatus: 'ACTIVE',
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  /** CARD: refund real al PSP via RefundsService. */
  private async refundCardFlow(input: {
    tenantId: string;
    walletId: string;
    actor: { userId: string; role: Role; tenantId: string };
    dto: RefundWalletDto;
  }): Promise<RefundWalletResult> {
    const refundsSvc = this.getRefundsService();
    if (!refundsSvc) {
      throw new ConflictException(
        'Refund CARD no disponible: RefundsService no inicializado. Reintenta o avisa al admin.',
      );
    }

    // 1) Lock + leer top-ups en transacción corta. Marcamos balance=0 pero
    //    NO cambiamos status todavía — eso lo hacemos tras éxito PSP.
    const { balanceCents, topUps } = await this.prisma.$transaction(async (tx) => {
      const w = await this.lockAndValidate(tx, input.tenantId, input.walletId);
      const tops = await tx.payment.findMany({
        where: {
          tenantId: input.tenantId,
          walletId: input.walletId,
          status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED'] },
          availableAmountCents: { gt: 0 },
        },
        orderBy: { createdAt: 'desc' }, // más recientes primero
        select: { id: true, availableAmountCents: true },
      });
      // Reservamos el balance: marcamos a 0 para evitar consumes concurrentes
      // mientras procesamos el refund al PSP. Si fallamos, restauramos.
      await tx.clientWallet.update({
        where: { id: input.walletId },
        data: { balanceCents: 0 },
      });
      return { balanceCents: w.balanceCents, topUps: tops };
    });

    if (topUps.length === 0) {
      // Edge: wallet con balance pero sin top-ups AUTHORIZED. Restauramos y avisamos.
      await this.prisma.clientWallet.update({
        where: { id: input.walletId },
        data: { balanceCents },
      });
      throw new ConflictException(
        `Wallet con balance ${(balanceCents / 100).toFixed(2)}€ pero sin top-ups AUTHORIZED — no se puede refund vía PSP. Revisa el ledger.`,
      );
    }

    // 2) Distribuir refund entre top-ups (más reciente primero).
    let remaining = balanceCents;
    let totalRefunded = 0;
    const refundIds: string[] = [];
    const errors: Array<{ paymentId: string; error: string }> = [];

    for (const p of topUps) {
      if (remaining <= 0) break;
      const chunk = Math.min(remaining, p.availableAmountCents);
      try {
        const r = await refundsSvc.refund(
          {
            paymentId: p.id,
            amountCents: chunk,
            reason: `wallet ${input.walletId} refund`,
          },
          input.actor,
        );
        refundIds.push(r.id);
        totalRefunded += chunk;
        remaining -= chunk;
        this.logger.log(
          `Wallet ${input.walletId} refund chunk ${chunk}c on payment ${p.id} → refund ${r.id}`,
        );
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.error(`Wallet refund chunk failed payment=${p.id}: ${msg}`);
        errors.push({ paymentId: p.id, error: msg });
        // Abortar — el resto del balance queda no refundeado, pero las chunks
        // ya hechas siguen efectivas. Restauramos el balance no devuelto.
        break;
      }
    }

    // 3) Estado final: marcar wallet REFUNDED si refund total OK, ACTIVE+restaurar
    //    balance restante si hubo error parcial.
    if (errors.length === 0 && remaining === 0) {
      await this.prisma.clientWallet.update({
        where: { id: input.walletId },
        data: { status: 'REFUNDED' },
      });
    } else {
      // Restauramos balance no refundeado para que admin pueda reintentar.
      await this.prisma.clientWallet.update({
        where: { id: input.walletId },
        data: { balanceCents: remaining },
      });
    }

    await this.audit.log({
      action: 'wallet.refund',
      tenantId: input.tenantId,
      actorId: input.actor.userId,
      targetType: 'ClientWallet',
      targetId: input.walletId,
      payload: {
        method: 'CARD',
        balanceCents,
        totalRefunded,
        remainingCents: remaining,
        refundIds,
        errors,
        notes: input.dto.notes,
      },
    });

    if (errors.length > 0) {
      throw new ConflictException(
        `Refund parcial: ${(totalRefunded / 100).toFixed(2)}€ devueltos al cliente, ${(remaining / 100).toFixed(2)}€ pendientes por error PSP en payment ${errors[0]!.paymentId}: ${errors[0]!.error}`,
      );
    }

    return {
      walletId: input.walletId,
      method: 'CARD',
      refundedCents: totalRefunded,
      newStatus: 'REFUNDED',
      expiresAt: null,
    };
  }

  /** Lock + validaciones comunes para refund. */
  private async lockAndValidate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    walletId: string,
  ): Promise<{ id: string; balanceCents: number; status: string; tenantId: string }> {
    const locked = await tx.$queryRaw<
      Array<{ id: string; balanceCents: number; status: string; tenantId: string }>
    >`
      SELECT id, "balanceCents", status, "tenantId"
        FROM client_wallets
       WHERE id = ${walletId}::uuid
         FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new NotFoundException(`Wallet ${walletId} no encontrada`);
    }
    const w = locked[0]!;
    if (w.tenantId !== tenantId) {
      throw new ForbiddenException('Wallet no pertenece a tu venue');
    }
    if (w.status !== 'ACTIVE') {
      throw new ConflictException(`Wallet ya está ${w.status} — no se puede refund`);
    }
    return w;
  }

  /**
   * Cancela un consumption. Devuelve el balance al wallet + marca el earning
   * como reversed (si existía).
   */
  async reverseConsumption(input: {
    tenantId: string;
    walletId: string;
    consumptionId: string;
    actorUserId: string;
    reason: string;
  }): Promise<{ refundedCents: number; newBalanceCents: number }> {
    return this.prisma.$transaction(async (tx) => {
      const consumption = await tx.walletConsumption.findFirst({
        where: {
          id: input.consumptionId,
          walletId: input.walletId,
          tenantId: input.tenantId,
        },
        include: { earning: true },
      });
      if (!consumption) {
        throw new NotFoundException('Consumption no encontrado');
      }
      if (consumption.reversedAt) {
        throw new ConflictException('Consumption ya estaba reversed');
      }

      // Sumar al balance del wallet
      await tx.clientWallet.update({
        where: { id: input.walletId },
        data: {
          balanceCents: { increment: consumption.amountCents },
          // Si estaba DEPLETED, vuelve a ACTIVE
          status: 'ACTIVE',
        },
      });

      // Marcar el consumption reversed
      await tx.walletConsumption.update({
        where: { id: input.consumptionId },
        data: {
          reversedAt: new Date(),
          reversedByUserId: input.actorUserId,
          notes: consumption.notes
            ? `${consumption.notes}\n[REVERSED: ${input.reason}]`
            : `[REVERSED: ${input.reason}]`,
        },
      });

      // Si había earning, marcar reversedCents = commissionCents (cancela)
      if (consumption.earning) {
        await tx.operatorEarning.update({
          where: { id: consumption.earning.id },
          data: { reversedCents: consumption.earning.commissionCents },
        });
      }

      const wallet = await tx.clientWallet.findUnique({
        where: { id: input.walletId },
        select: { balanceCents: true },
      });

      await this.audit.log({
        action: 'wallet.consumption.reversed',
        tenantId: input.tenantId,
        actorId: input.actorUserId,
        targetType: 'WalletConsumption',
        targetId: input.consumptionId,
        payload: { reason: input.reason, refundedCents: consumption.amountCents },
      });

      return {
        refundedCents: consumption.amountCents,
        newBalanceCents: wallet?.balanceCents ?? 0,
      };
    });
  }

  /** Lista wallets del venue para el admin panel. */
  async listForAdmin(input: {
    tenantId: string;
    status?: 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED';
    limit?: number;
  }) {
    const wallets = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findMany({
        where: {
          tenantId: input.tenantId,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit ?? 50,
        select: {
          id: true,
          identifier: true,
          balanceCents: true,
          status: true,
          expiresAt: true,
          qrToken: true,
          createdAt: true,
          _count: { select: { consumptions: true } },
        },
      }),
    );
    return wallets.map((w) => ({
      id: w.id,
      identifier: w.identifier,
      balanceCents: w.balanceCents,
      status: w.status as 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED',
      expiresAt: w.expiresAt?.toISOString() ?? null,
      qrToken: w.qrToken,
      consumptionCount: w._count.consumptions,
      createdAt: w.createdAt.toISOString(),
    }));
  }

  /** Vista admin de una wallet con sus consumos. */
  async getWalletView(input: {
    tenantId: string;
    walletId: string;
  }): Promise<
    ClientWalletView & {
      consumptions: Array<{
        id: string;
        amountCents: number;
        category: string;
        notes: string | null;
        reversedAt: string | null;
        providedByEmail: string;
        providedByName: string | null;
        createdAt: string;
      }>;
    }
  > {
    const wallet = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findFirst({
        where: { id: input.walletId, tenantId: input.tenantId },
        include: {
          consumptions: {
            orderBy: { createdAt: 'desc' },
            include: {
              providedBy: { select: { email: true, displayName: true } },
            },
          },
        },
      }),
    );
    if (!wallet) throw new NotFoundException('Wallet no encontrada');
    return {
      id: wallet.id,
      identifier: wallet.identifier,
      balanceCents: wallet.balanceCents,
      status: wallet.status as ClientWalletView['status'],
      expiresAt: wallet.expiresAt?.toISOString() ?? null,
      qrToken: wallet.qrToken,
      createdAt: wallet.createdAt.toISOString(),
      consumptions: wallet.consumptions.map((c) => ({
        id: c.id,
        amountCents: c.amountCents,
        category: c.category,
        notes: c.notes,
        reversedAt: c.reversedAt?.toISOString() ?? null,
        providedByEmail: c.providedBy.email,
        providedByName: c.providedBy.displayName,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  /** Vista pública por qrToken — la usa el cliente desde su móvil. */
  async getPublicByToken(qrToken: string) {
    const wallet = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findUnique({
        where: { qrToken },
        include: {
          consumptions: {
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: {
              providedBy: { select: { displayName: true } },
            },
          },
        },
      }),
    );
    if (!wallet) throw new NotFoundException('Wallet no encontrada');
    return {
      id: wallet.id,
      balanceCents: wallet.balanceCents,
      status: wallet.status,
      expiresAt: wallet.expiresAt?.toISOString() ?? null,
      consumptions: wallet.consumptions
        .filter((c) => !c.reversedAt)
        .map((c) => ({
          id: c.id,
          amountCents: c.amountCents,
          category: c.category,
          providedByName: c.providedBy.displayName,
          createdAt: c.createdAt.toISOString(),
        })),
    };
  }

  /** Stats agregadas para el admin panel. */
  async getAdminStats(tenantId: string): Promise<WalletsAdminStats> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const activeRows = await this.prisma.$queryRaw<
      Array<{ count: bigint; totalBalance: bigint }>
    >`
      SELECT COUNT(*)::bigint AS count, COALESCE(SUM("balanceCents"),0)::bigint AS "totalBalance"
        FROM client_wallets
       WHERE "tenantId" = ${tenantId}::uuid AND status = 'ACTIVE'
    `;

    const topUpRows = await this.prisma.$queryRaw<
      Array<{ total: bigint }>
    >`
      SELECT COALESCE(SUM("amountCents"),0)::bigint AS total
        FROM payments
       WHERE "tenantId" = ${tenantId}::uuid
         AND "walletId" IS NOT NULL
         AND status = 'AUTHORIZED'
         AND "createdAt" >= ${todayStart}
    `;

    const consumptionRows = await this.prisma.$queryRaw<
      Array<{ category: string; total: bigint }>
    >`
      SELECT category, COALESCE(SUM("amountCents"),0)::bigint AS total
        FROM wallet_consumptions
       WHERE "tenantId" = ${tenantId}::uuid
         AND "reversedAt" IS NULL
         AND "createdAt" >= ${todayStart}
       GROUP BY category
    `;

    const todayConsumptionsCents = consumptionRows.reduce(
      (sum, r) => sum + Number(r.total),
      0,
    );

    return {
      activeCount: Number(activeRows[0]?.count ?? 0),
      totalBalanceCents: Number(activeRows[0]?.totalBalance ?? 0),
      todayTopUpsCents: Number(topUpRows[0]?.total ?? 0),
      todayConsumptionsCents,
      // TODO: refunds requiere tabla refunds o tracking dedicado. Placeholder.
      todayRefundsCents: 0,
      byCategory: Object.fromEntries(
        consumptionRows.map((r) => [r.category, Number(r.total)]),
      ),
    };
  }
}
