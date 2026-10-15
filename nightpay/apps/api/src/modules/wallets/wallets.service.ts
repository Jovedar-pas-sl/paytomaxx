import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { formatWalletCode, newWalletCode, newWalletToken } from './wallet-rules';
import type { ClientWalletView, WalletsAdminStats } from '@nightpay/contracts';

/** Intentos para dar con un código corto libre (31^6 combinaciones). */
const MAX_CODE_ATTEMPTS = 5;

/**
 * Saldos para el panel (lista, ficha, estadísticas), la vista pública vieja
 * y anular un consumo. La recarga la suma al saldo el cobro (payments) y la
 * devolución del saldo está en WalletChargesService.payout.
 */
@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(AuditService) audit: AuditService) {
    this.prisma = prisma;
    this.audit = audit;
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
    const venue = await this.prisma.venue.findUnique({
      where: { id: input.tenantId },
      select: { walletGroup: true },
    });
    // Saldo NightPay: código corto que enseña el cliente (único entre las
    // activas; se reintenta si coincide) y grupo de locales donde vale.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const wallet = await this.prisma.asSystem((tx) =>
          tx.clientWallet.create({
            data: {
              tenantId: input.tenantId,
              identifier: input.identifier ?? null,
              qrToken: newWalletToken(),
              shortCode: newWalletCode(),
              walletGroup: venue?.walletGroup ?? null,
            },
            select: { id: true, qrToken: true },
          }),
        );
        this.logger.log(
          `Wallet created id=${wallet.id} tenant=${input.tenantId} identifier=${input.identifier ?? '-'}`,
        );
        return wallet;
      } catch (err) {
        const clash = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!clash || attempt >= MAX_CODE_ATTEMPTS) throw err;
      }
    }
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
    return this.prisma.asSystem(async (tx) => {
      // La wallet bloqueada: dos anulaciones a la vez (doble clic) o una
      // anulación y una devolución del saldo no se pisan.
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status::text AS status FROM client_wallets
         WHERE id = ${input.walletId}::uuid AND "tenantId" = ${input.tenantId}::uuid
         FOR UPDATE
      `;
      const consumption = await tx.walletConsumption.findFirst({
        where: {
          id: input.consumptionId,
          walletId: input.walletId,
          tenantId: input.tenantId,
        },
        include: { earning: true },
      });
      if (!consumption || locked.length === 0) {
        throw new NotFoundException('Consumption no encontrado');
      }
      if (consumption.reversedAt) {
        throw new ConflictException('Consumption ya estaba reversed');
      }
      const wallet0 = locked[0];
      // Una wallet ya devuelta o caducada no se reabre: el dinero se devuelve aparte.
      if (wallet0?.status === 'REFUNDED' || wallet0?.status === 'EXPIRED') {
        throw new ConflictException('El saldo de este cliente ya se cerró: devuélvele este importe aparte');
      }
      // Se devuelve todo lo que se descontó: importe y propina.
      const refunded = consumption.amountCents + consumption.tipCents;

      await tx.clientWallet.update({
        where: { id: input.walletId },
        data: {
          balanceCents: { increment: refunded },
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

      // Si había earning, se anula entero: comisión y propina. Si ya se le
      // había pagado a la chica, queda como deuda para su siguiente pago.
      if (consumption.earning) {
        const e = consumption.earning;
        const owed = e.commissionCents + e.tipCents - e.reversedCents;
        if (e.payoutId && owed > 0) {
          await tx.$executeRaw`
            INSERT INTO earning_reversals ("tenantId", "earningId", "consumptionId", "reversedDeltaCents", "afterPayout")
            VALUES (${e.tenantId}::uuid, ${e.id}::uuid, ${consumption.id}::uuid, ${owed}::int, true)
            ON CONFLICT ("consumptionId") DO NOTHING
          `;
        } else if (!e.payoutId) {
          await tx.operatorEarning.update({
            where: { id: e.id },
            data: { reversedCents: e.commissionCents + e.tipCents },
          });
        }
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
        payload: { reason: input.reason, refundedCents: refunded },
      });

      return {
        refundedCents: refunded,
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
          createdAt: true,
          shortCode: true,
          closeRequestedAt: true,
          pinHash: true,
          pinLockedAt: true,
          _count: { select: { consumptions: true, passkeys: true, cards: { where: { status: 'ACTIVE' } } } },
        },
      }),
    );
    return wallets.map((w) => ({
      id: w.id,
      code: w.shortCode ? formatWalletCode(w.shortCode) : null,
      closeRequestedAt: w.closeRequestedAt?.toISOString() ?? null,
      identifier: w.identifier,
      balanceCents: w.balanceCents,
      status: w.status as 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED',
      expiresAt: w.expiresAt?.toISOString() ?? null,
      consumptionCount: w._count.consumptions,
      createdAt: w.createdAt.toISOString(),
      /** El cliente activó Face ID (paga escaneando el QR de la chica). */
      hasFaceId: w._count.passkeys > 0,
      /** Puede pagar sin sacar el móvil, con su PIN (y si está bloqueado por fallos). */
      hasPin: w.pinHash !== null,
      pinLocked: w.pinLockedAt !== null,
      /** Tiene ficha NFC activa. */
      hasCard: w._count.cards > 0,
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
