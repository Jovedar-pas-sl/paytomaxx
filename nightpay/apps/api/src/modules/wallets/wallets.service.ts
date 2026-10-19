import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { madridDay, madridStartOfDay } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { formatWalletCode, newWalletCode, newWalletToken, sameWalletGroup } from './wallet-rules';
import { reopenData } from './wallet-activation';
import { lockLiveWallet } from './wallet-merge-chain';
import { PAID_STATUSES_SQL, paymentAt } from '../reports/reporting-sql';
import type { ClientWalletView, Role, WalletsAdminStats } from '@nightpay/contracts';
import { TotpService } from '../auth/totp.service';
import { assertManagerTwoFactor, eur } from './wallet-two-factor';

/** Intentos para dar con un código corto libre (31^6 combinaciones). */
const MAX_CODE_ATTEMPTS = 5;

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

interface LockedConsumption {
  id: string;
  amountCents: number;
  tipCents: number;
  notes: string | null;
  reversedAt: Date | null;
}

/**
 * El consumo de este saldo cobrado en este local, bloqueado: de dos
 * anulaciones a la vez (doble clic), la segunda ya lo ve anulado.
 */
async function lockConsumption(
  tx: RawTx,
  input: { consumptionId: string; walletId: string; tenantId: string },
): Promise<LockedConsumption | null> {
  const rows = await tx.$queryRaw<LockedConsumption[]>`
    SELECT id, "amountCents", "tipCents", notes, "reversedAt"
      FROM wallet_consumptions
     WHERE id = ${input.consumptionId}::uuid AND "walletId" = ${input.walletId}::uuid AND "tenantId" = ${input.tenantId}::uuid
     FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** Lo ya anulado (importe y propina) en estos saldos. */
async function reversedOnWalletsCents(tx: RawTx, walletIds: string[]): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ total: bigint | null }>>`
    SELECT COALESCE(SUM("amountCents" + "tipCents"), 0)::bigint AS total
      FROM wallet_consumptions
     WHERE "walletId" = ANY(${[...new Set(walletIds)]}::uuid[]) AND "reversedAt" IS NOT NULL
  `;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Anula la parte de la chica de un consumo (comisión y propina) con su fila
 * bloqueada, como applyRefundToEarning en payments. createPayout también la
 * bloquea: o se anula antes de pagarle (y ya no cuenta en el pago) o se ve
 * aquí ya pagada y queda como deuda para su siguiente pago
 * (earning_reversals.afterPayout). Lo ya descontado no se descuenta otra vez.
 */
async function reverseEarningOf(tx: RawTx, consumptionId: string): Promise<void> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; tenantId: string; commissionCents: number; tipCents: number; reversedCents: number; payoutId: string | null }>
  >`
    SELECT id, "tenantId", "commissionCents", "tipCents", "reversedCents", "payoutId"
      FROM operator_earnings WHERE "consumptionId" = ${consumptionId}::uuid
     FOR UPDATE
  `;
  const earning = rows[0];
  if (!earning) return;
  const debts = await tx.$queryRaw<Array<{ total: bigint }>>`
    SELECT COALESCE(SUM("reversedDeltaCents"), 0)::bigint AS total
      FROM earning_reversals WHERE "earningId" = ${earning.id}::uuid AND "afterPayout"
  `;
  const owed = earning.commissionCents + earning.tipCents - earning.reversedCents - Number(debts[0]?.total ?? 0);
  if (owed <= 0) return;
  if (earning.payoutId) {
    await tx.$executeRaw`
      INSERT INTO earning_reversals ("tenantId", "earningId", "consumptionId", "reversedDeltaCents", "afterPayout")
      VALUES (${earning.tenantId}::uuid, ${earning.id}::uuid, ${consumptionId}::uuid, ${owed}::int, true)
      ON CONFLICT ("consumptionId") DO NOTHING
    `;
    return;
  }
  await tx.$executeRaw`
    UPDATE operator_earnings SET "reversedCents" = "reversedCents" + ${owed}::int WHERE id = ${earning.id}::uuid
  `;
}

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
  private readonly totp: TotpService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(TotpService) totp: TotpService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.totp = totp;
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
   * Anula un consumo del saldo (lo hace el local donde se cobró): devuelve
   * importe y propina al saldo que usa hoy el cliente y anula la parte de la
   * chica. En una transacción, bloqueando en este orden: el consumo (doble
   * clic), el saldo vivo (lo que se le devuelva o cobre a la vez) y la parte
   * de la chica (un pago a la chica a la vez: si ya se le pagó, queda deuda).
   * El encargado, desde el umbral del local sumando lo ya anulado en ese
   * saldo, pone su código 2FA (wallet-two-factor.ts).
   */
  async reverseConsumption(input: {
    tenantId: string;
    walletId: string;
    consumptionId: string;
    actorUserId: string;
    /** Sin él (llamadas internas) no se pide 2FA: solo el encargado la pone. */
    actorRole?: Role;
    totpCode?: string;
    reason: string;
  }): Promise<{ refundedCents: number; newBalanceCents: number }> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: input.tenantId },
      select: { walletGroup: true, refundApprovalThresholdCents: true },
    });
    const done = await this.prisma.acrossVenues(async (tx) => {
      const consumption = await lockConsumption(tx, input);
      if (!consumption) throw new NotFoundException('Consumption no encontrado');
      if (consumption.reversedAt) throw new ConflictException('Consumption ya estaba reversed');
      // El saldo por su id (vale en todo el grupo) y, si se sumó a otro con su
      // Face ID, aquel: es donde el cliente tiene hoy su dinero.
      const wallet = await lockLiveWallet(tx, input.walletId);
      if (!wallet || !sameWalletGroup(wallet, { id: input.tenantId, walletGroup: venue?.walletGroup ?? null })) {
        throw new NotFoundException('Consumption no encontrado');
      }
      // Un saldo ya devuelto o caducado no se reabre: el dinero se devuelve aparte.
      if (wallet.status === 'REFUNDED' || wallet.status === 'EXPIRED') {
        throw new ConflictException('El saldo de este cliente ya se cerró: devuélvele este importe aparte');
      }
      // Se devuelve todo lo que se descontó: importe y propina. A 0 se reabre
      // (con otro código si el suyo lo tiene ya otro cliente).
      const refunded = consumption.amountCents + consumption.tipCents;
      const twoFactor = await this.reversalTwoFactor(
        tx,
        input,
        [input.walletId, wallet.id],
        refunded,
        venue?.refundApprovalThresholdCents,
      );
      await tx.clientWallet.update({
        where: { id: wallet.id },
        data: { balanceCents: { increment: refunded }, ...(await reopenData(tx, wallet)) },
      });
      await tx.walletConsumption.update({
        where: { id: consumption.id },
        data: {
          reversedAt: new Date(),
          reversedByUserId: input.actorUserId,
          notes: consumption.notes ? `${consumption.notes}\n[REVERSED: ${input.reason}]` : `[REVERSED: ${input.reason}]`,
        },
      });
      await reverseEarningOf(tx, consumption.id);
      return { refunded, twoFactor, walletId: wallet.id, newBalanceCents: wallet.balanceCents + refunded };
    });

    await this.audit.log({
      action: 'wallet.consumption.reversed',
      tenantId: input.tenantId,
      actorId: input.actorUserId,
      targetType: 'WalletConsumption',
      targetId: input.consumptionId,
      payload: {
        reason: input.reason,
        refundedCents: done.refunded,
        twoFactor: done.twoFactor,
        ...(done.walletId !== input.walletId ? { creditedWalletId: done.walletId } : {}),
      },
    });
    return { refundedCents: done.refunded, newBalanceCents: done.newBalanceCents };
  }

  /**
   * 2FA del encargado al anular: cuenta esta anulación más lo ya anulado en el
   * saldo (el del consumo y el que usa hoy el cliente), por cualquiera: diez
   * anulaciones de 20 € no se saltan el umbral. Con el saldo vivo bloqueado.
   */
  private async reversalTwoFactor(
    tx: RawTx,
    input: { actorUserId: string; actorRole?: Role; totpCode?: string },
    walletIds: string[],
    refunded: number,
    thresholdCents: number | undefined,
  ): Promise<boolean> {
    if (input.actorRole !== 'MANAGER') return false;
    const before = await reversedOnWalletsCents(tx, walletIds);
    const total = before + refunded;
    const what = before > 0 ? `Anular ${eur(total)} en este saldo (sumando lo ya anulado)` : `Anular ${eur(total)}`;
    return assertManagerTwoFactor(
      this.totp,
      { userId: input.actorUserId, role: input.actorRole },
      total,
      thresholdCents,
      input.totpCode,
      what,
    );
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

  /**
   * Stats agregadas para el panel. "Hoy" es el día de Madrid (desde sus 00:00).
   * Con el local en la sesión (client_wallets y wallet_consumptions tienen RLS
   * forzado) y, además, filtrado a mano.
   */
  async getAdminStats(tenantId: string): Promise<WalletsAdminStats> {
    const todayStart = madridStartOfDay(madridDay());
    return this.prisma.withTenant(tenantId, async (tx) => {
      const activeRows = await tx.$queryRaw<Array<{ count: bigint; totalBalance: bigint }>>`
        SELECT COUNT(*)::bigint AS count, COALESCE(SUM("balanceCents"),0)::bigint AS "totalBalance"
          FROM client_wallets
         WHERE "tenantId" = ${tenantId}::uuid AND status = 'ACTIVE'
      `;
      // Como el Z (reporting-sql): las recargas pagadas, también las devueltas
      // luego (PARTIALLY_REFUNDED/REFUNDED), por cuándo las autorizó el banco.
      const topUpRows = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM(p."amountCents"),0)::bigint AS total
          FROM payments p
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p."walletId" IS NOT NULL
           AND p.status IN ${PAID_STATUSES_SQL}
           AND ${paymentAt('p')} >= ${todayStart}
      `;
      const consumptionRows = await tx.$queryRaw<Array<{ category: string; total: bigint }>>`
        SELECT category, COALESCE(SUM("amountCents"),0)::bigint AS total
          FROM wallet_consumptions
         WHERE "tenantId" = ${tenantId}::uuid
           AND "reversedAt" IS NULL
           AND "createdAt" >= ${todayStart}
         GROUP BY category
      `;
      // Devuelto hoy desde este local: las devoluciones del saldo hechas (a la
      // tarjeta y en efectivo). Las de la tarjeta son también devoluciones de
      // las recargas: se cuentan una vez, aquí.
      const refundRows = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM("amountCents"),0)::bigint AS total
          FROM wallet_payouts
         WHERE "tenantId" = ${tenantId}::uuid
           AND status = 'DONE'
           AND "createdAt" >= ${todayStart}
      `;
      return {
        activeCount: Number(activeRows[0]?.count ?? 0),
        totalBalanceCents: Number(activeRows[0]?.totalBalance ?? 0),
        todayTopUpsCents: Number(topUpRows[0]?.total ?? 0),
        todayConsumptionsCents: consumptionRows.reduce((sum, r) => sum + Number(r.total), 0),
        todayRefundsCents: Number(refundRows[0]?.total ?? 0),
        byCategory: Object.fromEntries(consumptionRows.map((r) => [r.category, Number(r.total)])),
      };
    });
  }
}
