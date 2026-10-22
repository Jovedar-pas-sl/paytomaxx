import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  CASH_LIMIT_CENTS,
  CASH_TOP_UP_METHODS,
  CASH_TOP_UP_VOID_WINDOW_MINUTES,
  DEVICE_CASH_TOP_UP_DENIED_MESSAGE,
  MAX_CASH_TOP_UP_CENTS,
  STAFF_PERMISSION_DENIED_CODE,
  deviceCan,
  staffPermissionsOf,
  normalizeWalletCardUid,
  type CashTopUpResult,
  type CashTopUpVoidResult,
  type Role,
  type TopUpWalletDto,
} from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { totpForbidden } from '../auth/totp-code';
import { TotpService } from '../auth/totp.service';
import { assertCanHandleCash, chargeRightsFor } from '../venues/charge-rights';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { assertVenueAcceptsCharges } from '../venues/venue-pause';
import { insertEmptyWallet } from './empty-wallet';
import { reopenData } from './wallet-activation';
import { cashTopUpOverLimit, walletCash } from './wallet-cash-limits';
import { lockLiveWallet } from './wallet-merge-chain';
import { formatWalletCode, normalizeWalletCode, sameWalletGroup } from './wallet-rules';
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

const KEY_REUSED = 'Esa recarga ya se apuntó con otros datos: vuelve a empezar la recarga';

/**
 * Saldos nuevos en efectivo seguidos de la misma persona o datáfono: en este
 * tiempo, si juntos llegan a 1.000 € (cada vez que pasan otros 1.000 €), sale
 * en Incidencias. Trocear una entrega de efectivo en saldos nuevos es la
 * forma de saltarse el tope de cada saldo.
 */
export const CASH_SPLIT_WINDOW_MINUTES = 60;

/** Una recarga en efectivo de este local que aún se puede anular (sin enseñar el saldo). */
export interface RecentCashTopUp {
  id: string;
  at: string;
  amountCents: number;
  /** K7Q-•••: para reconocer al cliente. */
  codeHint: string;
  voided: boolean;
}

/** Quien anula una recarga: encargado o dueño, con su 2FA. */
export interface CashVoidActor {
  userId: string;
  role: Role;
  tenantId: string;
}

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

  private readonly totp: Pick<TotpService, 'assertForUser' | 'isEnabled'>;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(TotpService) totp: TotpService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.totp = totp;
  }

  async topUp(venueId: string, by: CashTopUpBy, input: CashTopUpInput): Promise<CashTopUpResult> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > MAX_CASH_TOP_UP_CENTS) {
      throw new ConflictException('En efectivo, como mucho 999,99 € por recarga: el resto, con tarjeta');
    }
    const replay = await this.replay(venueId, by, input);
    if (replay) return replay;
    await this.assertAllowed(venueId, by);

    // El saldo que ya existe se busca antes (código o ficha) y se vuelve a
    // seguir (sumado a otro) con él bloqueado; el nuevo se crea dentro.
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
    if (createdWallet) await this.watchSplit(venueId, by, input.amountCents);
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

  /**
   * En pausa, formas de cobro apagadas o sin el permiso: no se cobra. El
   * efectivo y las recargas, solo en recepción (su puesto), el encargado o
   * el dueño, o el datáfono de recepción (si el dueño se lo deja).
   */
  private async assertAllowed(venueId: string, by: CashTopUpBy): Promise<void> {
    const { staffPermissions, rights } = await this.prisma.asSystem(async (tx) => {
      await assertVenueAcceptsCharges(tx, venueId);
      await assertVenueAcceptsMethods(tx, venueId, CASH_TOP_UP_METHODS);
      const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { staffPermissions: true } });
      return {
        staffPermissions: venue?.staffPermissions ?? null,
        rights: 'userId' in by ? await chargeRightsFor(tx, venueId, by) : null,
      };
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
    if (rights) assertCanHandleCash(rights, by, perms);
  }

  /**
   * Con el saldo bloqueado (el bueno, si se sumó a otro mientras tanto):
   * comprueba que sigue valiendo y que el efectivo de 24 h del saldo y de su
   * cadena no llega a 1.000 €, lo reabre si estaba a 0, suma el efectivo y
   * apunta la recarga. Todo o nada.
   */
  private async credit(
    tx: TransactionalClient,
    a: { venueId: string; walletGroup: string | null; walletId: string; by: CashTopUpBy; input: CashTopUpInput },
  ): Promise<{ topUpId: string; walletId: string; balanceCents: number; shortCode: string | null }> {
    const w = await lockLiveWallet(tx, a.walletId);
    if (!w || !sameWalletGroup(w, { id: a.venueId, walletGroup: a.walletGroup })) {
      throw new NotFoundException('Saldo no encontrado');
    }
    const flags = await tx.$queryRaw<Array<{ blockedAt: Date | null }>>`
      SELECT "blockedAt" FROM client_wallets WHERE id = ${w.id}::uuid
    `;
    if (flags[0]?.blockedAt) {
      throw new ConflictException('Este saldo está bloqueado: no se puede recargar. Avisa al encargado.');
    }
    if (w.status !== 'ACTIVE' && w.status !== 'DEPLETED') {
      throw new ConflictException('Este saldo ya está cerrado (devuelto): haz un saldo nuevo');
    }
    const over = cashTopUpOverLimit(a.input.amountCents, await walletCash(tx, w.id));
    if (over) throw new ConflictException({ message: over, code: 'CASH_LIMIT' });
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
        intentFingerprint: cashIntent(a.input.wallet),
        createdWallet: 'create' in a.input.wallet,
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

  /**
   * Saldos nuevos en efectivo seguidos de la misma persona o datáfono: si en
   * CASH_SPLIT_WINDOW_MINUTES juntos pasan otros 1.000 €, sale en Incidencias
   * («Efectivo troceado en saldos nuevos») y en el registro. Solo avisa: cada
   * saldo ya tiene su tope. Un fallo aquí no deshace la recarga.
   */
  private async watchSplit(venueId: string, by: CashTopUpBy, amountCents: number): Promise<void> {
    try {
      const since = new Date(Date.now() - CASH_SPLIT_WINDOW_MINUTES * 60 * 1000);
      const who =
        'userId' in by ? Prisma.sql`t."takenByUserId" = ${by.userId}::uuid` : Prisma.sql`t."terminalId" = ${by.terminalId}::uuid`;
      const rows = await this.prisma.asSystem((tx) => tx.$queryRaw<Array<{ count: number; totalCents: bigint | number }>>`
        SELECT COUNT(*)::int AS count, COALESCE(SUM(t."amountCents" + COALESCE(v."amountCents", 0)), 0)::bigint AS "totalCents"
          FROM wallet_cash_topups t
          LEFT JOIN wallet_cash_topups v ON v."voidOfId" = t.id
         WHERE t."tenantId" = ${venueId}::uuid AND t."createdWallet" AND t."voidOfId" IS NULL
           AND t."createdAt" >= ${since} AND ${who}
      `);
      const count = rows[0]?.count ?? 0;
      const total = Number(rows[0]?.totalCents ?? 0);
      if (count < 2 || Math.floor((total - amountCents) / CASH_LIMIT_CENTS) >= Math.floor(total / CASH_LIMIT_CENTS)) return;
      this.logger.warn(`Local ${venueId}: ${count} saldos nuevos en efectivo seguidos (${total}c) de ${JSON.stringify(by)}`);
      await this.audit.log({
        action: 'wallet.cash_split_suspected',
        tenantId: venueId,
        actorId: 'userId' in by ? by.userId : null,
        targetType: 'WalletCashTopUp',
        targetId: 'userId' in by ? by.userId : by.terminalId,
        payload: {
          amountCents: total,
          count,
          windowMinutes: CASH_SPLIT_WINDOW_MINUTES,
          ...('terminalId' in by ? { terminalId: by.terminalId } : { userId: by.userId }),
        },
      });
    } catch (err) {
      this.logger.error(`Aviso de efectivo troceado en ${venueId}: ${(err as Error).message}`);
    }
  }

  /**
   * Anular una recarga en efectivo reciente (mal tecleada): encargado o dueño,
   * con su 2FA, si el saldo aún la cubre. Es otra fila, negativa (voidOfId),
   * que resta en la caja, el Z y los informes; el saldo baja lo mismo. Una
   * anulación por recarga (índice único).
   */
  async voidTopUp(actor: CashVoidActor, topUpId: string, input: { reason: string; totpCode?: string }): Promise<CashTopUpVoidResult> {
    if (actor.role !== 'MANAGER' && actor.role !== 'OWNER') throw new ForbiddenException('Solo el encargado o el dueño');
    const what = 'Anular una recarga en efectivo';
    if (!input.totpCode) {
      if (!(await this.totp.isEnabled(actor.userId))) {
        throw totpForbidden('notEnrolled', `${what}: hace falta la app de verificación (2FA) y no la tienes activada.`);
      }
      throw totpForbidden('required', `${what}: pon el código de tu app de verificación (2FA).`);
    }
    await this.totp.assertForUser(actor.userId, input.totpCode);
    let out: CashTopUpVoidResult;
    try {
      out = await this.prisma.acrossVenues((tx) => this.applyVoid(tx, actor, topUpId, input.reason.trim()));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Esta recarga ya está anulada');
      }
      throw err;
    }
    await this.audit.log({
      action: 'wallet.cash_topup_voided',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: out.walletId,
      payload: { topUpId, voidId: out.voidId, amountCents: out.amountCents, reason: input.reason.trim() },
    });
    this.logger.log(`Recarga en efectivo ${topUpId} anulada (−${out.amountCents}c) por ${actor.userId}`);
    return out;
  }

  /** Las recargas en efectivo de este local en el plazo para anularlas, la más reciente primero. */
  async recent(venueId: string): Promise<RecentCashTopUp[]> {
    const since = new Date(Date.now() - CASH_TOP_UP_VOID_WINDOW_MINUTES * 60 * 1000);
    const rows = await this.prisma.withTenant(venueId, (tx) =>
      tx.walletCashTopUp.findMany({
        where: { tenantId: venueId, voidOfId: null, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, createdAt: true, amountCents: true, walletId: true, voidedBy: { select: { id: true } } },
      }),
    );
    const codes = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findMany({ where: { id: { in: rows.map((r) => r.walletId) } }, select: { id: true, shortCode: true } }),
    );
    const codeOf = new Map(codes.map((c) => [c.id, c.shortCode]));
    return rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      amountCents: r.amountCents,
      codeHint: `${(codeOf.get(r.walletId) ?? '').slice(0, 3)}-•••`,
      voided: r.voidedBy !== null,
    }));
  }

  /** Con la recarga y el saldo bueno bloqueados: comprueba y apunta la fila negativa. */
  private async applyVoid(
    tx: TransactionalClient,
    actor: CashVoidActor,
    topUpId: string,
    reason: string,
  ): Promise<CashTopUpVoidResult> {
    const rows = await tx.$queryRaw<Array<{ id: string; walletId: string; amountCents: number; createdAt: Date }>>`
      SELECT id::text AS id, "walletId"::text AS "walletId", "amountCents", "createdAt"
        FROM wallet_cash_topups
       WHERE id = ${topUpId}::uuid AND "tenantId" = ${actor.tenantId}::uuid AND "voidOfId" IS NULL
       FOR UPDATE
    `;
    const topUp = rows[0];
    if (!topUp) throw new NotFoundException('Recarga en efectivo no encontrada');
    if (await tx.walletCashTopUp.findUnique({ where: { voidOfId: topUp.id }, select: { id: true } })) {
      throw new ConflictException('Esta recarga ya está anulada');
    }
    if (Date.now() - topUp.createdAt.getTime() > CASH_TOP_UP_VOID_WINDOW_MINUTES * 60 * 1000) {
      throw new ConflictException(
        `Solo se anulan las recargas de las últimas ${CASH_TOP_UP_VOID_WINDOW_MINUTES / 60} h: devuelve el saldo con «Me voy»`,
      );
    }
    const w = await lockLiveWallet(tx, topUp.walletId);
    if (!w || w.status !== 'ACTIVE' || w.balanceCents < topUp.amountCents) {
      throw new ConflictException(
        `El saldo ya no cubre la recarga (le quedan ${eur(w?.status === 'ACTIVE' ? w.balanceCents : 0)}): ya se ha gastado o devuelto. Devuelve lo que quede con «Me voy».`,
      );
    }
    const left = w.balanceCents - topUp.amountCents;
    await tx.clientWallet.update({
      where: { id: w.id },
      data: { balanceCents: left, ...(left === 0 ? { status: 'DEPLETED' as const } : {}) },
    });
    const row = await tx.walletCashTopUp.create({
      data: {
        tenantId: actor.tenantId,
        walletId: topUp.walletId,
        amountCents: -topUp.amountCents,
        takenByUserId: actor.userId,
        idempotencyKey: `void:${topUp.id}`,
        voidOfId: topUp.id,
        reason,
      },
      select: { id: true },
    });
    return { voidId: row.id, topUpId: topUp.id, walletId: w.id, amountCents: topUp.amountCents, balanceCents: left };
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
    if (existing.intentFingerprint ? existing.intentFingerprint !== cashIntent(input.wallet) : existing.createdWallet !== ('create' in input.wallet)) {
      throw new ConflictException(KEY_REUSED);
    }
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: existing.walletId }, select: { id: true, balanceCents: true, shortCode: true } }),
    );
    // Legacy rows cannot prove whether code or card was originally used. Accept
    // aliases only when they still identify the same wallet/merge chain.
    if (!existing.intentFingerprint && !('create' in input.wallet)) {
      const ref = input.wallet;
      const matches = wallet && await this.prisma.acrossVenues(async (tx) => {
        if ('code' in ref && normalizeWalletCode(ref.code) === wallet.shortCode) return true;
        const candidate = 'code' in ref
          ? await tx.clientWallet.findFirst({ where: { shortCode: normalizeWalletCode(ref.code) }, select: { id: true } })
          : await tx.walletCard.findUnique({ where: { token: ref.card }, select: { walletId: true, uid: true } });
        if (!candidate) return false;
        if ('uid' in candidate && candidate.uid && 'uid' in ref && ref.uid && candidate.uid !== normalizeWalletCardUid(ref.uid)) return false;
        const id = 'walletId' in candidate ? candidate.walletId : candidate.id;
        if (!id) return false;
        if (id === existing.walletId) return true;
        const liveId = async (start: string): Promise<string | null> => {
          let current = start;
          for (let hops = 0; hops <= 5; hops += 1) {
            const row = await tx.clientWallet.findUnique({ where: { id: current }, select: { mergedIntoId: true } });
            if (!row) return null;
            if (!row.mergedIntoId) return current;
            current = row.mergedIntoId;
          }
          return null;
        };
        const original = await liveId(existing.walletId);
        return original !== null && original === await liveId(id);
      });
      if (!matches) throw new ConflictException(KEY_REUSED);
    }
    return {
      topUpId: existing.id,
      walletId: existing.walletId,
      code: formatWalletCode(wallet?.shortCode ?? ''),
      amountCents: existing.amountCents,
      balanceCents: wallet?.balanceCents ?? 0,
      createdWallet: existing.createdWallet,
      replayed: true,
    };
  }
}

/** Preserve the submitted destination even when the wallet is merged or its code rotates. */
function cashIntent(wallet: TopUpWalletDto): string {
  const target = 'create' in wallet
    ? ['create', wallet.identifier?.trim() || null]
    : 'code' in wallet
      ? ['code', normalizeWalletCode(wallet.code)]
      : ['card', wallet.card, wallet.uid ? normalizeWalletCardUid(wallet.uid) : null];
  return createHash('sha256').update(JSON.stringify(target)).digest('hex');
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

function isKeyClash(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  return JSON.stringify(err.meta?.target ?? '').includes('idempotencyKey');
}
