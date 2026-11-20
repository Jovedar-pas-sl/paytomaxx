import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { formatChargeRef } from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ISSUED_CARD_STATUSES, recordCardEvents } from '../wallet-card-ops';
import { liveWalletId, lockLiveWallet } from '../wallet-merge-chain';
import { formatWalletCode } from '../wallet-rules';
import { notMeChargeId, notMePath, notMeSecret, signNotMeToken, verifyNotMeToken } from './not-me-token';

/** Lo que apunta el registro (y lee la incidencia de recepción y el encargado). */
export const CHARGE_DISPUTED_ACTION = 'wallet.charge_disputed_by_client';

/** Por qué el enlace no sirve (la página lo dice sin dar datos). */
export type NotMeRefusal = 'invalid' | 'expired' | 'not-paid';

export interface NotMeCharge {
  /** «C-0042» (null en cobros de antes de las referencias). */
  ref: string | null;
  /** Lo que salió del saldo: importe + propina. */
  totalCents: number;
  venueName: string | null;
  at: Date;
  /** El saldo (donde está hoy el dinero) tiene Face ID: con él sigue pagando. Sin él, nada lo promete. */
  hasFaceId: boolean;
}

export type NotMeView =
  | { state: NotMeRefusal }
  | ({ state: 'ask' | 'already' } & NotMeCharge);

export type NotMeResult =
  | { state: NotMeRefusal }
  | ({ state: 'already' } & NotMeCharge)
  | ({ state: 'done'; blockedCards: number; pinLocked: boolean } & NotMeCharge);

interface ChargeRow {
  id: string;
  tenantId: string;
  walletId: string | null;
  status: string;
  amountCents: number;
  tipCents: number;
  ref: number | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/**
 * «No he sido yo» desde el aviso de un cobro (/w/no/<token>). Con el enlace
 * firmado de ESE cobro de ESE saldo (not-me-token.ts):
 *  - Mirar (GET) no cambia nada (las vistas previas de los chats lo abren).
 *  - Confirmar (POST) bloquea sus fichas (como «He perdido mi NFC») y su PIN
 *    (como tras 5 PIN fallados): con ellos ya no paga nadie. Su Face ID, si lo
 *    tiene, sigue pagando: lo tiene el dueño del móvil. Y deja un aviso en Incidencias del
 *    local del cobro para recepción y el encargado. No devuelve dinero: lo
 *    decide el local tras revisarlo.
 *  - Una vez por cobro (la segunda, «ya nos lo has dicho»).
 * Se quita: el encargado desbloquea el PIN (Saldos) y recepción da una ficha nueva.
 */
@Injectable()
export class ChargeDisputeService {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject('CHARGE_DISPUTE_ENV') env?: NodeJS.ProcessEnv,
  ) {
    this.env = env ?? process.env;
  }

  /** Lo que enseña la página antes de confirmar. */
  async view(token: string): Promise<NotMeView> {
    const chargeId = notMeChargeId(token);
    if (!chargeId) return { state: 'invalid' };
    return this.prisma.acrossVenues(async (tx) => {
      const charge = await tx.walletChargeRequest.findUnique({ where: { id: chargeId }, select: CHARGE_SELECT });
      const refusal = this.refusal(token, charge);
      if (refusal || !charge) return { state: refusal ?? 'invalid' };
      const info = await chargeInfo(tx, charge);
      return { state: (await alreadyDisputed(tx, chargeId)) ? 'already' : 'ask', ...info };
    });
  }

  /** Confirmado: bloquea fichas y PIN y avisa al local. */
  async dispute(token: string): Promise<NotMeResult> {
    const chargeId = notMeChargeId(token);
    if (!chargeId) return { state: 'invalid' };
    return this.prisma.acrossVenues(async (tx) => {
      // El cobro bloqueado: dos «No he sido yo» a la vez avisan una sola vez.
      const rows = await tx.$queryRaw<ChargeRow[]>`
        SELECT id::text AS id, "tenantId"::text AS "tenantId", "walletId"::text AS "walletId", status,
               "amountCents", "tipCents", ref, "decidedAt", "createdAt"
          FROM wallet_charge_requests WHERE id = ${chargeId}::uuid FOR UPDATE
      `;
      const charge = rows[0] ?? null;
      const refusal = this.refusal(token, charge);
      if (refusal || !charge?.walletId) return { state: refusal ?? 'invalid' };
      const info = await chargeInfo(tx, charge);
      if (await alreadyDisputed(tx, charge.id)) return { state: 'already', ...info };

      // El saldo donde está hoy el dinero (si se sumó a otro, aquel), bloqueado.
      const wallet = await lockLiveWallet(tx, charge.walletId);
      if (!wallet) return { state: 'invalid' };
      const now = new Date();
      const cards = await tx.walletCard.findMany({
        where: { walletId: wallet.id, status: { in: ISSUED_CARD_STATUSES } },
        select: { id: true, venueId: true },
      });
      if (cards.length > 0) {
        await tx.walletCard.updateMany({
          where: { id: { in: cards.map((c) => c.id) }, status: { in: ISSUED_CARD_STATUSES } },
          data: { status: 'BLOCKED', blockedAt: now },
        });
        for (const card of cards) {
          await recordCardEvents(tx, [{ cardId: card.id, walletId: wallet.id, kind: 'BLOCKED' }], {
            venueId: card.venueId ?? wallet.tenantId,
            by: { userId: null },
            now,
          });
        }
      }
      // El PIN, como tras los PIN fallados: lo desbloquea el encargado.
      const pin = await tx.clientWallet.updateMany({
        where: { id: wallet.id, pinHash: { not: null }, pinLockedAt: null },
        data: { pinLockedAt: now },
      });
      const pinLocked = pin.count > 0 || (await hasLockedPin(tx, wallet.id));
      await this.audit.logInTx(tx, {
        action: CHARGE_DISPUTED_ACTION,
        // El aviso, al local del cobro: allí lo revisan y, si procede, lo devuelven.
        tenantId: charge.tenantId,
        actorId: null,
        targetType: 'WalletChargeRequest',
        targetId: charge.id,
        payload: {
          via: 'push_not_me',
          ref: info.ref,
          amountCents: info.totalCents,
          code: wallet.shortCode ? formatWalletCode(wallet.shortCode) : null,
          walletId: wallet.id,
          cards: cards.length,
          pinLocked,
          // Sin Face ID, la incidencia no dice que con él sigue pagando.
          faceId: info.hasFaceId,
        },
      });
      return { state: 'done', blockedCards: cards.length, pinLocked, ...info };
    });
  }

  /**
   * «No he sido yo» desde los movimientos del saldo (/w): el mismo enlace
   * firmado que el aviso, para un cobro pagado de ESTE saldo (quien llama ya
   * comprobó el acceso y su Face ID). Pedirlo no cambia nada: se confirma en
   * su página. Otro saldo, sin pagar o que no existe: 404.
   */
  async linkFor(walletId: string, chargeId: string): Promise<string> {
    const charge = await this.prisma.acrossVenues((tx) =>
      tx.walletChargeRequest.findUnique({ where: { id: chargeId }, select: { walletId: true, status: true } }),
    );
    if (!charge || charge.walletId !== walletId || charge.status !== 'ACCEPTED') throw new NotFoundException('Cobro no encontrado');
    return notMePath(signNotMeToken({ chargeId, walletId }, Date.now(), notMeSecret(this.env)));
  }

  /** null si el enlace vale para este cobro pagado; si no, por qué no. */
  private refusal(token: string, charge: Pick<ChargeRow, 'walletId' | 'status'> | null): NotMeRefusal | null {
    if (!charge?.walletId) return 'invalid';
    const check = verifyNotMeToken(token, charge.walletId, Date.now(), notMeSecret(this.env));
    if (check !== 'ok') return check;
    return charge.status === 'ACCEPTED' ? null : 'not-paid';
  }
}

const CHARGE_SELECT = {
  id: true,
  tenantId: true,
  walletId: true,
  status: true,
  amountCents: true,
  tipCents: true,
  ref: true,
  decidedAt: true,
  createdAt: true,
} as const;

type RawTx = Pick<TransactionalClient, '$queryRaw' | 'venue' | 'walletPasskey'>;

async function chargeInfo(tx: RawTx, charge: ChargeRow): Promise<NotMeCharge> {
  const venue = await tx.venue.findUnique({ where: { id: charge.tenantId }, select: { name: true } });
  // El saldo que bloquea «No he sido yo»: si se sumó a otro, aquel.
  const walletId = charge.walletId ? ((await liveWalletId(tx, charge.walletId)) ?? charge.walletId) : null;
  return {
    ref: formatChargeRef(charge.ref),
    totalCents: charge.amountCents + (charge.tipCents ?? 0),
    venueName: venue?.name ?? null,
    at: charge.decidedAt ?? charge.createdAt,
    hasFaceId: walletId !== null && (await tx.walletPasskey.count({ where: { walletId } })) > 0,
  };
}

async function alreadyDisputed(tx: Pick<TransactionalClient, '$queryRaw'>, chargeId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one FROM audit_events WHERE action = ${CHARGE_DISPUTED_ACTION} AND "targetId" = ${chargeId} LIMIT 1
  `;
  return rows.length > 0;
}

async function hasLockedPin(tx: Pick<TransactionalClient, '$queryRaw'>, walletId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT ("pinLockedAt" IS NOT NULL) AS locked FROM client_wallets WHERE id = ${walletId}::uuid
  `;
  return rows[0]?.locked === true;
}
