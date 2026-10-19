import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CASH_TOP_UP_METHODS,
  DEVICE_CASH_TOP_UP_DENIED_MESSAGE,
  MAX_CASH_TOP_UP_CENTS,
  STAFF_PERMISSION_DENIED_CODE,
  deviceCan,
  staffCan,
  staffPermissionsOf,
  type CashTopUpResult,
  type TopUpWalletDto,
} from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { permissionDenied } from '../venues/staff-permission.guard';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { assertVenueAcceptsCharges } from '../venues/venue-pause';
import { insertEmptyWallet } from './empty-wallet';
import { reopenData } from './wallet-activation';
import { formatWalletCode, sameWalletGroup } from './wallet-rules';
import { topUpTarget } from './wallet-topup-target';

/**
 * Quién cobra el efectivo: una persona de la app (con su rol, para el
 * permiso «cobrar recargas en efectivo») o el datáfono de recepción (sin
 * persona: el permiso de los datáfonos).
 */
export type CashTopUpBy = { userId: string; role: string } | { terminalId: string };

export interface CashTopUpInput {
  amountCents: number;
  idempotencyKey: string;
  wallet: TopUpWalletDto;
}

type LockedWallet = {
  id: string;
  tenantId: string;
  walletGroup: string | null;
  balanceCents: number;
  status: string;
  shortCode: string | null;
  mergedIntoId: string | null;
  blockedAt: Date | null;
};

const KEY_REUSED = 'Esa recarga ya se apuntó con otros datos: vuelve a empezar la recarga';

/**
 * Recarga del saldo en efectivo (recepción). El efectivo no pasa por el banco,
 * así que NO es un cobro (payments): ni pasarela, ni FSM, ni devolución a la
 * tarjeta, ni cuadre con el banco. Es la entrada simétrica a la devolución en
 * efectivo (wallet_payouts CASH): una fila en wallet_cash_topups y el saldo
 * sumado, en la misma transacción. Cuenta como dinero cobrado al cargarlo
 * (igual que la recarga con tarjeta: el IVA va con la recarga, los consumos
 * del saldo no se facturan otra vez) y entra en la caja de la noche.
 *
 * Lo guardan: el local en pausa (423), «Saldo» y «Recarga en efectivo» en
 * Formas de cobro (409), el permiso «cobrar recargas en efectivo» (de la
 * persona o de los datáfonos, 403), el tope legal de efectivo y la
 * Idempotency-Key (el mismo botón dos veces no carga dos veces).
 */
@Injectable()
export class CashTopUpService {
  private readonly logger = new Logger(CashTopUpService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(AuditService) audit: AuditService) {
    this.prisma = prisma;
    this.audit = audit;
  }

  async topUp(venueId: string, by: CashTopUpBy, input: CashTopUpInput): Promise<CashTopUpResult> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > MAX_CASH_TOP_UP_CENTS) {
      throw new ConflictException('En efectivo, como mucho 999,99 € por recarga: el resto, con tarjeta');
    }
    const replay = await this.replay(venueId, by, input);
    if (replay) return replay;
    await this.assertAllowed(venueId, by);

    // El saldo que ya existe se busca antes (código o ficha); el nuevo se crea dentro.
    const target = 'create' in input.wallet ? null : await topUpTarget(this.prisma, venueId, input.wallet);
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } });
    const walletGroup = venue?.walletGroup ?? null;
    let result: { topUpId: string; walletId: string; balanceCents: number; shortCode: string | null };
    try {
      result = await this.prisma.acrossVenues(async (tx) => {
        const walletId =
          target?.id ??
          (await insertEmptyWallet(tx, venueId, {
            identifier: 'create' in input.wallet ? (input.wallet.identifier?.trim() || null) : null,
            walletGroup,
          }));
        return this.credit(tx, { venueId, walletGroup, walletId, by, input });
      });
    } catch (err) {
      // Dos peticiones a la vez con la misma clave: gana una y la otra la repite.
      if (isKeyClash(err)) {
        const raced = await this.replay(venueId, by, input);
        if (raced) return raced;
      }
      throw err;
    }
    const createdWallet = target === null;
    await this.audit.log({
      action: 'wallet.cash_topup',
      tenantId: venueId,
      actorId: 'userId' in by ? by.userId : null,
      targetType: 'ClientWallet',
      targetId: result.walletId,
      payload: {
        topUpId: result.topUpId,
        amountCents: input.amountCents,
        createdWallet,
        ...('terminalId' in by ? { terminalId: by.terminalId } : {}),
      },
    });
    this.logger.log(`Saldo ${result.walletId}: +${input.amountCents}c en efectivo (${'userId' in by ? by.userId : `datáfono ${by.terminalId}`})`);
    return {
      topUpId: result.topUpId,
      walletId: result.walletId,
      code: formatWalletCode(result.shortCode ?? ''),
      amountCents: input.amountCents,
      balanceCents: result.balanceCents,
      createdWallet,
      replayed: false,
    };
  }

  /** ¿Se puede cobrar efectivo aquí y quién? (para enseñar o esconder la opción). null = sí. */
  async cashBlockedReason(venueId: string, by: CashTopUpBy): Promise<string | null> {
    try {
      await this.assertAllowed(venueId, by);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  /** En pausa, formas de cobro apagadas o sin el permiso: no se cobra. */
  private async assertAllowed(venueId: string, by: CashTopUpBy): Promise<void> {
    const staffPermissions = await this.prisma.asSystem(async (tx) => {
      await assertVenueAcceptsCharges(tx, venueId);
      await assertVenueAcceptsMethods(tx, venueId, CASH_TOP_UP_METHODS);
      const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { staffPermissions: true } });
      return venue?.staffPermissions ?? null;
    });
    const perms = staffPermissionsOf(staffPermissions);
    if ('terminalId' in by) {
      if (!deviceCan(perms, 'cashTopUp')) {
        throw new ForbiddenException({
          message: DEVICE_CASH_TOP_UP_DENIED_MESSAGE,
          code: STAFF_PERMISSION_DENIED_CODE,
          permission: 'cashTopUp',
        });
      }
      return;
    }
    if (!staffCan(perms, { role: by.role, userId: by.userId }, 'cashTopUp')) throw permissionDenied('cashTopUp');
  }

  /**
   * Con el saldo bloqueado: comprueba que sigue valiendo, lo reabre si estaba
   * a 0, suma el efectivo y apunta la recarga. Todo o nada.
   */
  private async credit(
    tx: TransactionalClient,
    a: { venueId: string; walletGroup: string | null; walletId: string; by: CashTopUpBy; input: CashTopUpInput },
  ): Promise<{ topUpId: string; walletId: string; balanceCents: number; shortCode: string | null }> {
    const rows = await tx.$queryRaw<LockedWallet[]>`
      SELECT id::text AS id, "tenantId"::text AS "tenantId", "walletGroup", "balanceCents",
             status::text AS status, "shortCode", "mergedIntoId"::text AS "mergedIntoId", "blockedAt"
        FROM client_wallets WHERE id = ${a.walletId}::uuid FOR UPDATE
    `;
    const w = rows[0];
    if (!w || !sameWalletGroup(w, { id: a.venueId, walletGroup: a.walletGroup })) {
      throw new NotFoundException('Saldo no encontrado');
    }
    if (w.blockedAt) throw new ConflictException('Este saldo está bloqueado: no se puede recargar. Avisa al encargado.');
    if (w.mergedIntoId || (w.status !== 'ACTIVE' && w.status !== 'DEPLETED')) {
      throw new ConflictException('Este saldo ya está cerrado (devuelto): haz un saldo nuevo');
    }
    const reopen = await reopenData(tx, w);
    await tx.clientWallet.update({
      where: { id: w.id },
      // Recarga: el cliente se queda (un «Me voy» pendiente ya no vale).
      data: { balanceCents: { increment: a.input.amountCents }, closeRequestedAt: null, ...reopen },
    });
    const row = await tx.walletCashTopUp.create({
      data: {
        tenantId: a.venueId,
        walletId: w.id,
        amountCents: a.input.amountCents,
        takenByUserId: 'userId' in a.by ? a.by.userId : null,
        terminalId: 'terminalId' in a.by ? a.by.terminalId : null,
        idempotencyKey: a.input.idempotencyKey,
      },
      select: { id: true },
    });
    return {
      topUpId: row.id,
      walletId: w.id,
      balanceCents: w.balanceCents + a.input.amountCents,
      shortCode: reopen.shortCode ?? w.shortCode,
    };
  }

  /** La misma recarga pedida otra vez: la ya apuntada (o 409 si la clave es de otra). */
  private async replay(venueId: string, by: CashTopUpBy, input: CashTopUpInput): Promise<CashTopUpResult | null> {
    const existing = await this.prisma.asSystem((tx) =>
      tx.walletCashTopUp.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: venueId, idempotencyKey: input.idempotencyKey } },
      }),
    );
    if (!existing) return null;
    const sameWho =
      'userId' in by ? existing.takenByUserId === by.userId : existing.terminalId === by.terminalId;
    if (!sameWho || existing.amountCents !== input.amountCents) throw new ConflictException(KEY_REUSED);
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: existing.walletId }, select: { balanceCents: true, shortCode: true } }),
    );
    return {
      topUpId: existing.id,
      walletId: existing.walletId,
      code: formatWalletCode(wallet?.shortCode ?? ''),
      amountCents: existing.amountCents,
      balanceCents: wallet?.balanceCents ?? 0,
      createdWallet: 'create' in input.wallet,
      replayed: true,
    };
  }
}

function isKeyClash(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  return JSON.stringify(err.meta?.target ?? '').includes('idempotencyKey');
}
