import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { stepUpActions } from '@nightpay/contracts';
import { passkeyInstead, type TwoFactorDeps } from './wallet-two-factor';
import {
  CASH_LIMIT_CENTS,
  CASH_TOP_UP_METHODS,
  CASH_TOP_UP_UNDO_SECONDS,
  CASH_TOP_UP_VOID_WINDOW_MINUTES,
  CASH_UNDO_REASON_LABEL,
  DEVICE_CASH_TOP_UP_DENIED_MESSAGE,
  MAX_CASH_TOP_UP_CENTS,
  STAFF_PERMISSION_DENIED_CODE,
  deviceCan,
  serviceFeeQuote,
  staffPermissionsOf,
  type CashTopUpResult,
  type CashTopUpUndoDto,
  type CashTopUpVoidResult,
  type FichaCheck,
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
import { assertEventOpen } from '../party/event-window';
import { insertEmptyWallet } from './empty-wallet';
import { attachCardInTx, isIssuedCard, type CardBy } from './wallet-card-ops';
import { reopenData } from './wallet-activation';
import { cashTopUpOverLimit, walletCash } from './wallet-cash-limits';
import { cashIntentFingerprint, isNewCardRetry, storedReceipt, type PrintedTopUpRef } from './wallet-cash-intent';
import { liveWalletId, lockLiveWallet } from './wallet-merge-chain';
import { formatWalletCode, normalizeWalletCode, sameWalletGroup } from './wallet-rules';
import { assertFichaInHand } from './wallet-fresh-topup';
import { topUpTarget } from './wallet-topup-target';
import { VENUE_SERVICE_FEE_SELECT, venueServiceFeeOf } from '../payments/service-fee';
import { eur } from '../../common/money/eur';

/**
 * Quién cobra el efectivo: una persona de la app (con su rol, para el
 * permiso «cobrar recargas en efectivo») o el datáfono de recepción (sin
 * persona: el permiso de los datáfonos).
 */
export type CashTopUpBy = { userId: string; role: string } | { terminalId: string };

export interface CashTopUpInput {
  /** El saldo que se carga. */
  amountCents: number;
  idempotencyKey: string;
  /** Lo de la petición, o la ficha buscada por su número impreso (solo FichaNumbersService). */
  wallet: TopUpWalletDto | PrintedTopUpRef;
  /**
   * La «Comisión del servicio» que enseñó la pantalla (CashTopUpSchema). Sin
   * ella (app anterior) y con la comisión encendida: 409, no se cobra.
   */
  serviceFeeCents?: number;
  /** B2: acercando otra vez la ficha o «Cargar sin leerla» (queda en el registro). */
  fichaCheck?: FichaCheck;
}

/** La comisión del servicio de una recarga en efectivo: el % y el importe del momento. */
interface CashFee {
  bps: number | null;
  cents: number;
}

export type { PrintedTopUpRef };

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
  /** Su «Comisión del servicio» (al anularla, sale de la caja con el saldo). */
  serviceFeeCents: number;
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

  private readonly totp: TwoFactorDeps;

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
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { walletGroup: true, ...VENUE_SERVICE_FEE_SELECT },
    });
    const walletGroup = venue?.walletGroup ?? null;
    // «Comisión del servicio» de las recargas (el % del local ahora): la que
    // enseñó la pantalla tiene que ser esta, y el total, menos de 1.000 €.
    const fee = this.cashFee(venue, input);
    const newCard = newCardOf(input.wallet);
    let result: { topUpId: string; walletId: string; balanceCents: number; shortCode: string | null };
    try {
      result = await this.prisma.acrossVenues(async (tx) => {
        const walletId =
          target?.id ??
          (await insertEmptyWallet(tx, venueId, {
            identifier: 'create' in input.wallet ? (input.wallet.identifier?.trim() || null) : null,
            walletGroup,
          }));
        // El saldo nuevo con su ficha, en la misma operación: si la ficha no
        // se puede dar, no se carga nada (ni queda un saldo sin ficha).
        if (newCard) await attachCardInTx(tx, { walletId, venueId, card: newCard.card, uid: newCard.uid, by: cardByOf(by) });
        return this.credit(tx, { venueId, walletGroup, walletId, by, input, fee });
      });
    } catch (err) {
      // Dos peticiones a la vez con la misma clave: gana una y la otra la repite.
      // Cualquier choque de único vale: si no era el de la clave, replay no
      // encuentra nada y sigue el error (Prisma no siempre sabe qué índice fue:
      // con Postgres en otro idioma da «(not available)»).
      if (isUniqueClash(err)) {
        const raced = await this.replay(venueId, by, input);
        if (raced) return raced;
      }
      throw err;
    }
    const createdWallet = target === null;
    if (createdWallet) await this.watchSplit(venueId, by, input.amountCents);
    if (newCard) {
      await this.audit.log({
        action: 'wallet.card_linked',
        tenantId: venueId,
        actorId: 'userId' in by ? by.userId : null,
        targetType: 'ClientWallet',
        targetId: result.walletId,
        payload: { replacedCards: 0, withUid: newCard.uid !== null, atTopUp: true, ...('terminalId' in by ? { terminalId: by.terminalId } : {}) },
      });
    }
    await this.audit.log({
      action: 'wallet.cash_topup',
      tenantId: venueId,
      actorId: 'userId' in by ? by.userId : null,
      targetType: 'ClientWallet',
      targetId: result.walletId,
      payload: {
        topUpId: result.topUpId,
        amountCents: input.amountCents,
        ...(fee.cents > 0 ? { serviceFeeCents: fee.cents, serviceFeeBps: fee.bps } : {}),
        createdWallet,
        // B2: cómo se confirmó con la ficha; «sin leerla» queda apuntado aquí.
        ...(input.fichaCheck ? { fichaCheck: input.fichaCheck } : {}),
        ...('terminalId' in by ? { terminalId: by.terminalId } : {}),
      },
    });
    this.logger.log(`Saldo ${result.walletId}: +${input.amountCents}c en efectivo (${'userId' in by ? by.userId : `datáfono ${by.terminalId}`})`);
    return {
      topUpId: result.topUpId,
      walletId: result.walletId,
      code: formatWalletCode(result.shortCode ?? ''),
      amountCents: input.amountCents,
      ...feeFields(input.amountCents, fee),
      balanceCents: result.balanceCents,
      createdWallet,
      replayed: false,
      ...(newCard ? { cardLinked: true } : {}),
    };
  }

  /**
   * La «Comisión del servicio» de esta recarga (el % de las recargas del local
   * ahora). 409 si la pantalla enseñó otra (cambió el %) o no sabe cobrarla
   * (app anterior, sin el campo), y si saldo + comisión pasan del tope de una
   * recarga en efectivo: así en la caja nunca se apunta lo que no se cobró.
   */
  private cashFee(venue: Parameters<typeof venueServiceFeeOf>[0], input: CashTopUpInput): CashFee {
    const quote = serviceFeeQuote(venueServiceFeeOf(venue), 'topUp', input.amountCents);
    if (input.serviceFeeCents === undefined && quote.feeCents > 0) {
      throw new ConflictException({
        message: 'Esta pantalla no cobra la comisión del servicio: recárgala para actualizarla y vuelve a cobrar.',
        code: 'SERVICE_FEE_APP_OUTDATED',
        serviceFeeCents: quote.feeCents,
      });
    }
    if (input.serviceFeeCents !== undefined && input.serviceFeeCents !== quote.feeCents) {
      throw new ConflictException({
        message: `La comisión del servicio ha cambiado: ahora son ${eur(quote.feeCents)}. Vuelve a cobrar.`,
        code: 'SERVICE_FEE_CHANGED',
        serviceFeeCents: quote.feeCents,
      });
    }
    if (quote.totalCents > MAX_CASH_TOP_UP_CENTS) {
      throw new ConflictException(
        `En efectivo, como mucho 999,99 € por pago (saldo + comisión del servicio): recarga como mucho ${eur(maxCashTopUpFor(quote.bps ?? 0))}. El resto, con tarjeta.`,
      );
    }
    return { bps: quote.bps, cents: quote.feeCents };
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
      // OxioParty: con la fiesta terminada, sin recargas nuevas (423 EVENT_ENDED). OxioPay: nada.
      await assertEventOpen(tx, venueId);
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
    a: { venueId: string; walletGroup: string | null; walletId: string; by: CashTopUpBy; input: CashTopUpInput; fee: CashFee },
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
    // El tope legal, por lo que paga el cliente: el saldo + la comisión del servicio.
    const over = cashTopUpOverLimit(a.input.amountCents + a.fee.cents, await walletCash(tx, w.id));
    if (over) throw new ConflictException({ message: over, code: 'CASH_LIMIT' });
    const reopen = await reopenData(tx, w);
    await tx.clientWallet.update({
      where: { id: w.id },
      // Recarga: el cliente se queda (un «Me voy» pendiente ya no vale).
      data: { balanceCents: { increment: a.input.amountCents }, closeRequestedAt: null, ...reopen },
    });
    const balanceCents = w.balanceCents + a.input.amountCents;
    const shortCode = reopen.shortCode ?? w.shortCode;
    const row = await tx.walletCashTopUp.create({
      data: {
        tenantId: a.venueId,
        walletId: w.id,
        amountCents: a.input.amountCents,
        takenByUserId: 'userId' in a.by ? a.by.userId : null,
        terminalId: 'terminalId' in a.by ? a.by.terminalId : null,
        idempotencyKey: a.input.idempotencyKey,
        intentFingerprint: cashIntentFingerprint(a.input),
        // La comisión del servicio del momento: entra en la caja y se debe a OxioPay.
        serviceFeeBps: a.fee.bps,
        serviceFeeCents: a.fee.cents,
        // El recibo de esta recarga: un reintento lo devuelve igual aunque el
        // saldo se sume luego a otro o siga moviéndose.
        receipt: { code: formatWalletCode(shortCode ?? ''), balanceCents },
        createdWallet: 'create' in a.input.wallet,
      },
      select: { id: true },
    });
    return { topUpId: row.id, walletId: w.id, balanceCents, shortCode };
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
  async voidTopUp(
    actor: CashVoidActor,
    topUpId: string,
    input: { reason: string; totpCode?: string; serviceFeeCents?: number },
  ): Promise<CashTopUpVoidResult> {
    if (actor.role !== 'MANAGER' && actor.role !== 'OWNER') throw new ForbiddenException('Solo el encargado o el dueño');
    // Antes del 2FA: que la pantalla diga lo que sale de la caja (saldo + comisión del servicio).
    await this.assertVoidFeeShown(actor.tenantId, topUpId, input.serviceFeeCents);
    const what = 'Anular una recarga en efectivo';
    const action = stepUpActions.cashTopUpVoid(topUpId);
    if (!input.totpCode) {
      if (await this.totp.isEnabled(actor.userId)) throw totpForbidden('required', `${what}: pon el código de tu app de verificación (2FA).`);
      // Sin 2FA: la prueba de su llave de acceso para esta anulación (si tiene llave).
      if (!(await passkeyInstead(this.totp, actor.userId, action, `${what}:`))) {
        throw totpForbidden('notEnrolled', `${what}: hace falta la app de verificación (2FA) y no la tienes activada.`);
      }
    } else {
      await this.totp.assertForUser(actor.userId, input.totpCode, action);
    }
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
      payload: {
        topUpId,
        voidId: out.voidId,
        amountCents: out.amountCents,
        ...(out.serviceFeeCents ? { serviceFeeCents: out.serviceFeeCents } : {}),
        reason: input.reason.trim(),
      },
    });
    this.logger.log(`Recarga en efectivo ${topUpId} anulada (−${out.amountCents}c) por ${actor.userId}`);
    return out;
  }

  /**
   * «Me he equivocado» (B4): quien la cargó deshace su recarga en efectivo en
   * los CASH_TOP_UP_UNDO_SECONDS siguientes, con el motivo y acercando la
   * misma ficha, y solo si el saldo aún la cubre (applyVoid). Es la misma
   * anulación que la del encargado (fila negativa, resta en la caja y el Z),
   * sin 2FA, y sale en Incidencias. Pasado el plazo, la anula el encargado.
   */
  async undo(actor: CashVoidActor, topUpId: string, input: CashTopUpUndoDto, now: Date = new Date()): Promise<CashTopUpVoidResult> {
    const row = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.walletCashTopUp.findUnique({
        where: { id: topUpId },
        select: { tenantId: true, walletId: true, takenByUserId: true, createdAt: true, voidOfId: true },
      }),
    );
    if (!row || row.tenantId !== actor.tenantId || row.voidOfId) throw new NotFoundException('Recarga en efectivo no encontrada');
    if (row.takenByUserId !== actor.userId) {
      throw new ForbiddenException('Solo la deshace quien la cargó: si no, que la anule el encargado.');
    }
    if (now.getTime() - row.createdAt.getTime() > CASH_TOP_UP_UNDO_SECONDS * 1000) {
      throw new ConflictException({ message: 'Han pasado más de 2 minutos: que la anule el encargado.', code: 'CASH_UNDO_LATE' });
    }
    await this.assertSameFicha(row.walletId, input);
    const label = CASH_UNDO_REASON_LABEL[input.reason];
    let out: CashTopUpVoidResult;
    try {
      out = await this.prisma.acrossVenues((tx) => this.applyVoid(tx, actor, topUpId, label));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Esta recarga ya está anulada');
      }
      throw err;
    }
    // A Incidencias (acción delicada): cobrar, cargar y deshacer podría ser una forma de quedarse efectivo.
    await this.audit.log({
      action: 'wallet.cash_topup_undone',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: out.walletId,
      payload: {
        topUpId,
        voidId: out.voidId,
        amountCents: out.amountCents,
        ...(out.serviceFeeCents ? { serviceFeeCents: out.serviceFeeCents } : {}),
        reason: input.reason,
        name: label,
      },
    });
    this.logger.log(`Recarga en efectivo ${topUpId} deshecha (−${out.amountCents}c, ${input.reason}) por ${actor.userId}`);
    return out;
  }

  /**
   * La ficha acercada es la del saldo de la recarga (o la del saldo al que se
   * sumó) y está delante: si tiene uid, leído y el mismo (como en la salida de
   * efectivo); con solo su enlace, 409 «acerca la ficha».
   */
  private async assertSameFicha(walletId: string, input: { card: string; uid?: string | undefined }): Promise<void> {
    const found = await this.prisma.acrossVenues(async (tx) => {
      const card = await tx.walletCard.findUnique({ where: { token: input.card }, select: { walletId: true, status: true, uid: true } });
      if (!card || !isIssuedCard(card) || !card.walletId) return null;
      const [mine, topUp] = await Promise.all([liveWalletId(tx, card.walletId), liveWalletId(tx, walletId)]);
      return mine !== null && mine === topUp ? { uid: card.uid } : null;
    });
    if (!found) throw new ConflictException('Esa no es la ficha de esta recarga: acerca la misma ficha.');
    assertFichaInHand(found.uid, input.uid);
  }

  /**
   * Anular una recarga con «Comisión del servicio» devuelve el saldo + ella:
   * la pantalla tiene que haberla enseñado (si no, el cliente recibiría solo
   * el saldo y la caja esperaría que salieran los dos). Sin ella, como siempre.
   */
  private async assertVoidFeeShown(tenantId: string, topUpId: string, shownFeeCents: number | undefined): Promise<void> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.walletCashTopUp.findUnique({
        where: { id: topUpId },
        select: { tenantId: true, voidOfId: true, amountCents: true, serviceFeeCents: true },
      }),
    );
    // La que no es de aquí o no es una recarga: lo dice applyVoid (404).
    if (!row || row.tenantId !== tenantId || row.voidOfId) return;
    const fee = row.serviceFeeCents ?? 0;
    const out = `de la caja salen ${eur(row.amountCents + fee)} (${eur(row.amountCents)} de saldo + ${eur(fee)} de comisión del servicio)`;
    if (shownFeeCents === undefined && fee !== 0) {
      throw new ConflictException({
        message: `Esta pantalla no enseña la comisión del servicio: ${out}. Recárgala y vuelve a anularla.`,
        code: 'SERVICE_FEE_APP_OUTDATED',
        serviceFeeCents: fee,
      });
    }
    if (shownFeeCents !== undefined && shownFeeCents !== fee) {
      throw new ConflictException({
        message: `La comisión del servicio de esa recarga es de ${eur(fee)}: ${out}. Recarga la pantalla y vuelve a anularla.`,
        code: 'SERVICE_FEE_CHANGED',
        serviceFeeCents: fee,
      });
    }
  }

  /** Las recargas en efectivo de este local en el plazo para anularlas, la más reciente primero. */
  async recent(venueId: string): Promise<RecentCashTopUp[]> {
    const since = new Date(Date.now() - CASH_TOP_UP_VOID_WINDOW_MINUTES * 60 * 1000);
    const rows = await this.prisma.withTenant(venueId, (tx) =>
      tx.walletCashTopUp.findMany({
        // Las cargas de los cajeros de otras plataformas no son de recepción: ni se ven ni se anulan aquí.
        where: { tenantId: venueId, voidOfId: null, partnerConnectionId: null, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, createdAt: true, amountCents: true, serviceFeeCents: true, walletId: true, voidedBy: { select: { id: true } } },
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
      serviceFeeCents: r.serviceFeeCents ?? 0,
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
    const rows = await tx.$queryRaw<
      Array<{ id: string; walletId: string; amountCents: number; serviceFeeBps: number | null; serviceFeeCents: number; createdAt: Date }>
    >`
      SELECT id::text AS id, "walletId"::text AS "walletId", "amountCents", "serviceFeeBps", "serviceFeeCents", "createdAt"
        FROM wallet_cash_topups
       WHERE id = ${topUpId}::uuid AND "tenantId" = ${actor.tenantId}::uuid AND "voidOfId" IS NULL
         AND "partnerConnectionId" IS NULL
       FOR UPDATE
    `;
    const topUp = rows[0];
    if (!topUp) throw new NotFoundException('Recarga en efectivo no encontrada');
    if (await tx.walletCashTopUp.findUnique({ where: { voidOfId: topUp.id }, select: { id: true } })) {
      throw new ConflictException('Esta recarga ya está anulada');
    }
    if (Date.now() - topUp.createdAt.getTime() > CASH_TOP_UP_VOID_WINDOW_MINUTES * 60 * 1000) {
      throw new ConflictException(
        `Solo se anulan las recargas de las últimas ${CASH_TOP_UP_VOID_WINDOW_MINUTES / 60} h. Pasado ese tiempo ya no se anula: habla con el dueño.`,
      );
    }
    const w = await lockLiveWallet(tx, topUp.walletId);
    if (!w || w.status !== 'ACTIVE' || w.balanceCents < topUp.amountCents) {
      throw new ConflictException(
        `El saldo ya no cubre la recarga (le quedan ${eur(w?.status === 'ACTIVE' ? w.balanceCents : 0)}): ya se ha gastado o devuelto. No se puede anular.`,
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
        // Anulada, la comisión del servicio también se devuelve (sale de la caja).
        serviceFeeBps: topUp.serviceFeeBps ?? null,
        serviceFeeCents: -(topUp.serviceFeeCents ?? 0),
      },
      select: { id: true },
    });
    return {
      voidId: row.id,
      topUpId: topUp.id,
      walletId: w.id,
      amountCents: topUp.amountCents,
      serviceFeeCents: topUp.serviceFeeCents ?? 0,
      balanceCents: left,
    };
  }

  /**
   * La misma recarga pedida otra vez: la ya apuntada, con su recibo (o 409 si
   * la clave es de otra petición: otra persona, otro importe u otro destino).
   */
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
    const sameIntent = existing.intentFingerprint
      ? existing.intentFingerprint === cashIntentFingerprint(input) || isNewCardRetry(existing, input)
      : await this.legacyIntentMatches(existing, input.wallet);
    if (!sameIntent) throw new ConflictException(KEY_REUSED);
    const receipt = storedReceipt(existing.receipt) ?? (await this.currentReceipt(existing.walletId));
    const newCard = newCardOf(input.wallet);
    return {
      topUpId: existing.id,
      walletId: existing.walletId,
      code: receipt.code,
      amountCents: existing.amountCents,
      ...feeFields(existing.amountCents, { bps: existing.serviceFeeBps ?? null, cents: existing.serviceFeeCents ?? 0 }),
      balanceCents: receipt.balanceCents,
      createdWallet: existing.createdWallet,
      replayed: true,
      ...(newCard ? { cardLinked: await this.cardIsIssuedTo(newCard.card, existing.walletId) } : {}),
    };
  }

  /** ¿Esta ficha está dada a este saldo? (la recarga repetida de un saldo nuevo con su ficha). */
  private async cardIsIssuedTo(card: string, walletId: string): Promise<boolean> {
    const row = await this.prisma.acrossVenues((tx) => tx.walletCard.findUnique({ where: { token: card }, select: { walletId: true, status: true } }));
    return row?.walletId === walletId && row.status === 'ISSUED';
  }

  /**
   * Recargas de antes de guardar la huella: no se sabe si se pidió por código
   * o por ficha. Vale si lo pedido ahora es el código que tenía aquel saldo, o
   * lleva hoy al mismo saldo que aquella (también tras sumarse a otro). Un
   * saldo nuevo solo repite otro saldo nuevo. Las de número impreso son
   * posteriores y siempre llevan huella: nunca casan con una antigua.
   */
  private async legacyIntentMatches(
    existing: { walletId: string; createdWallet: boolean },
    wallet: TopUpWalletDto | PrintedTopUpRef,
  ): Promise<boolean> {
    if ('printed' in wallet) return false;
    if ('create' in wallet) return existing.createdWallet;
    if (existing.createdWallet) return false;
    return this.prisma.acrossVenues(async (tx) => {
      const original = await tx.clientWallet.findUnique({ where: { id: existing.walletId }, select: { shortCode: true } });
      if (!original) return false;
      if ('code' in wallet && original.shortCode === normalizeWalletCode(wallet.code)) return true;
      const namedId =
        'code' in wallet
          ? (await tx.clientWallet.findFirst({ where: { shortCode: normalizeWalletCode(wallet.code) }, select: { id: true } }))?.id
          : (await tx.walletCard.findUnique({ where: { token: wallet.card }, select: { walletId: true } }))?.walletId;
      if (!namedId) return false;
      const live = await liveWalletId(tx, existing.walletId);
      return live !== null && live === (await liveWalletId(tx, namedId));
    });
  }

  /** Recibo de una recarga antigua (sin recibo guardado): el saldo como está ahora. */
  private async currentReceipt(walletId: string): Promise<{ code: string; balanceCents: number }> {
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true, shortCode: true } }),
    );
    return { code: formatWalletCode(wallet?.shortCode ?? ''), balanceCents: wallet?.balanceCents ?? 0 };
  }
}

/** Lo de la comisión del servicio en el recibo: el importe, su % y lo que pagó el cliente. */
function feeFields(amountCents: number, fee: CashFee): Pick<CashTopUpResult, 'serviceFeeCents' | 'serviceFeeBps' | 'chargedCents'> {
  return { serviceFeeCents: fee.cents, serviceFeeBps: fee.bps, chargedCents: amountCents + fee.cents };
}

/** La recarga en efectivo más grande con este % sin que saldo + comisión pasen del tope de un pago. */
export function maxCashTopUpFor(bps: number): number {
  let amount = Math.floor((MAX_CASH_TOP_UP_CENTS * 10_000) / (10_000 + Math.max(0, bps)));
  while (amount > 0 && serviceFeeQuote({ enabled: true, cardBps: 0, topUpBps: bps }, 'topUp', amount).totalCents > MAX_CASH_TOP_UP_CENTS) {
    amount -= 1;
  }
  return amount;
}

function isUniqueClash(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** La ficha nueva que va con el saldo nuevo (null: sin ficha, o no es un saldo nuevo). */
function newCardOf(wallet: TopUpWalletDto | PrintedTopUpRef): { card: string; uid: string | null } | null {
  if (!('create' in wallet) || !wallet.card) return null;
  return { card: wallet.card, uid: wallet.uid ?? null };
}

/** Quién da la ficha: la persona o el datáfono de recepción. */
function cardByOf(by: CashTopUpBy): CardBy {
  return 'userId' in by ? { userId: by.userId } : { userId: null, terminalId: by.terminalId };
}
