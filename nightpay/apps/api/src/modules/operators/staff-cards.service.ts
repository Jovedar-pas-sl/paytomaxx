import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  STAFF_CARD_COPY_MESSAGE,
  STAFF_CARD_INVALID_CODE,
  STAFF_CARD_NOT_BLANK_MESSAGE,
  STAFF_CARD_REVOKED_MESSAGE,
  STAFF_CARD_UNKNOWN_MESSAGE,
  normalizeWalletCardUid,
  type StaffCardResolved,
  type StaffCardView,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { photoHashesOf } from '../profile/photo-hashes';
import { signStaffToken, staffQrSecret } from './staff-qr';
import { staffName } from './staff-qr.controller';

type Actor = { userId: string; tenantId: string };
export type StaffCardRevokeReason = 'replaced' | 'revoked' | 'offboarded';

const invalid = (message: string) => new BadRequestException({ message, code: STAFF_CARD_INVALID_CODE });

/**
 * Anula la ficha viva de la compañera (si tiene) en la transacción que se le
 * pase: desde ese momento ya no vale. Devuelve su número (null si no tenía).
 */
export async function revokeLiveStaffCard(
  tx: Pick<TransactionalClient, 'staffCard'>,
  input: { tenantId: string; userId: string; byUserId: string | null; reason: StaffCardRevokeReason; now?: Date },
): Promise<number | null> {
  const live = await tx.staffCard.findFirst({
    where: { tenantId: input.tenantId, userId: input.userId, revokedAt: null },
    select: { id: true, number: true },
  });
  if (!live) return null;
  await tx.staffCard.update({
    where: { id: live.id },
    data: { revokedAt: input.now ?? new Date(), revokedById: input.byUserId, revokedReason: input.reason },
  });
  return live.number;
}

/** Su ficha viva, para su hoja (null sin ficha). Con bypass o en su local. */
export async function liveStaffCards(
  tx: Pick<TransactionalClient, 'staffCard'>,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, StaffCardView>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx.staffCard.findMany({
    where: { tenantId, userId: { in: [...userIds] }, revokedAt: null },
    select: { userId: true, number: true, createdAt: true },
  });
  return new Map(rows.map((r) => [r.userId, { number: r.number, issuedAt: r.createdAt.toISOString() }]));
}

/**
 * La ficha NFC de la compañera (cobro por el encargado, fase 2):
 *  - dar: el encargado o el dueño graban una ficha en blanco en su Android
 *    desde la hoja de la compañera; la de antes (si tenía) deja de valer en la
 *    misma operación;
 *  - anular: deja de valer (la ha perdido y aún no tiene otra);
 *  - leer: quien cobra un servicio a su nombre la acerca; vale solo el chip
 *    original, viva, de este local y de una compañera sin baja. Sale con un
 *    «Mi QR» firmado (lo mismo que si hubiera escaneado su QR).
 * Dar y anular quedan en el registro.
 */
@Injectable()
export class StaffCardsService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(AuditService) audit: AuditService) {
    this.prisma = prisma;
    this.audit = audit;
  }

  async issue(actor: Actor, operatorId: string, input: { card: string; uid: string }): Promise<StaffCardView> {
    const uid = normalizeWalletCardUid(input.uid);
    if (!uid) throw invalid('No se ha podido leer el número de serie del chip: acércala otra vez.');
    const out = await this.prisma.asSystem(async (tx) => {
      // Una a la vez por compañera: dos toques seguidos no le dejan dos fichas vivas.
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users
         WHERE id = ${operatorId}::uuid AND "tenantId" = ${actor.tenantId}::uuid AND role = 'OPERATOR' AND "deletedAt" IS NULL
         FOR UPDATE
      `;
      if (rows.length === 0) throw new NotFoundException('Compañera no encontrada');
      // Una ficha de cliente (por su código o su chip) no se convierte en la de una compañera.
      const client = await tx.walletCard.findFirst({ where: { OR: [{ token: input.card }, { uid }] }, select: { id: true } });
      if (client) throw new ConflictException(STAFF_CARD_NOT_BLANK_MESSAGE);
      const same = await tx.staffCard.findUnique({ where: { token: input.card } });
      if (same) {
        // La misma respuesta otra vez (se perdió la de antes): nada que hacer.
        if (same.userId === operatorId && same.uid === uid && !same.revokedAt) {
          return { view: { number: same.number, issuedAt: same.createdAt.toISOString() }, replaced: null, fresh: false };
        }
        throw new ConflictException(STAFF_CARD_NOT_BLANK_MESSAGE);
      }
      const chip = await tx.staffCard.findFirst({ where: { uid, revokedAt: null }, select: { userId: true } });
      if (chip && chip.userId !== operatorId) throw new ConflictException('Este chip ya es la ficha de otra compañera: usa otra en blanco.');
      const now = new Date();
      const replaced = await revokeLiveStaffCard(tx, { tenantId: actor.tenantId, userId: operatorId, byUserId: actor.userId, reason: 'replaced', now });
      // «Ficha nº …»: la misma secuencia que las fichas de los clientes (nunca se repite entre unas y otras).
      const [seq] = await tx.$queryRaw<Array<{ n: number }>>`SELECT nextval('wallet_cards_number_seq')::int AS n`;
      if (!seq) throw new Error('Sin número para la ficha');
      const n = seq.n;
      const card = await tx.staffCard.create({
        data: { tenantId: actor.tenantId, userId: operatorId, token: input.card, uid, number: n, issuedById: actor.userId, createdAt: now },
      });
      return { view: { number: card.number, issuedAt: card.createdAt.toISOString() }, replaced, fresh: true };
    });
    if (out.replaced !== null) {
      await this.audit.log({
        action: 'operator.staff_card_revoked',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        targetType: 'User',
        targetId: operatorId,
        payload: { number: out.replaced, reason: 'replaced', replacedBy: out.view.number },
      });
    }
    if (out.fresh) {
      await this.audit.log({
        action: 'operator.staff_card_issued',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        targetType: 'User',
        targetId: operatorId,
        payload: { number: out.view.number, ...(out.replaced !== null ? { replaces: out.replaced } : {}) },
      });
    }
    return out.view;
  }

  async revoke(actor: Actor, operatorId: string): Promise<{ revoked: number | null }> {
    const number = await this.prisma.asSystem(async (tx) => {
      const op = await tx.user.findFirst({ where: { id: operatorId, tenantId: actor.tenantId, role: 'OPERATOR' }, select: { id: true } });
      if (!op) throw new NotFoundException('Compañera no encontrada');
      return revokeLiveStaffCard(tx, { tenantId: actor.tenantId, userId: operatorId, byUserId: actor.userId, reason: 'revoked' });
    });
    if (number !== null) {
      await this.audit.log({
        action: 'operator.staff_card_revoked',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        targetType: 'User',
        targetId: operatorId,
        payload: { number, reason: 'revoked' },
      });
    }
    return { revoked: number };
  }

  /** La ficha acercada al cobrar un servicio a su nombre → la compañera y su «Mi QR» firmado. */
  async resolve(actor: Actor, input: { card: string; uid: string }): Promise<StaffCardResolved> {
    const uid = normalizeWalletCardUid(input.uid);
    if (!uid) throw invalid('No se ha podido leer el número de serie del chip: acércala otra vez.');
    const card = await this.prisma.asSystem((tx) =>
      tx.staffCard.findUnique({
        where: { token: input.card },
        select: {
          id: true,
          tenantId: true,
          uid: true,
          number: true,
          revokedAt: true,
          user: { select: { id: true, role: true, deletedAt: true, displayName: true, email: true } },
        },
      }),
    );
    if (!card || card.tenantId !== actor.tenantId) throw invalid(STAFF_CARD_UNKNOWN_MESSAGE);
    if (card.uid !== uid) {
      await this.audit.log({
        action: 'operator.staff_card_copy_suspected',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        targetType: 'User',
        targetId: card.user.id,
        payload: { number: card.number },
      });
      throw invalid(STAFF_CARD_COPY_MESSAGE);
    }
    if (card.revokedAt) throw invalid(STAFF_CARD_REVOKED_MESSAGE);
    if (card.user.role !== 'OPERATOR' || card.user.deletedAt) throw invalid(STAFF_CARD_UNKNOWN_MESSAGE);
    if (card.user.id === actor.userId) throw invalid('Esa es tu propia ficha: acerca la de la compañera.');
    const { token } = signStaffToken({ userId: card.user.id, tenantId: actor.tenantId }, Date.now(), staffQrSecret());
    const photos = await photoHashesOf(this.prisma, actor.tenantId, [card.user.id]);
    return { id: card.user.id, name: staffName(card.user), photoHash: photos.get(card.user.id) ?? null, token, cardNumber: card.number };
  }
}
