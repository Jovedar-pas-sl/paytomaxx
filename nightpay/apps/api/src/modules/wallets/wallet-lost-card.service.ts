import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ISSUED_CARD_STATUSES, recordCardEvents } from './wallet-card-ops';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { formatWalletCode } from './wallet-rules';

/** Lo que apunta el registro (y lee la incidencia del dueño). */
export const CLIENT_CARD_BLOCKED_ACTION = 'wallet.card_blocked_by_client';

interface LockedWallet {
  id: string;
  tenantId: string;
  shortCode: string | null;
  balanceCents: number;
}

function faceIdNotSet(): ConflictException {
  return new ConflictException({ message: 'Este saldo no tiene Face ID: para bloquear tu NFC, pide ayuda en recepción.', code: 'FACE_ID_NOT_SET' });
}

/**
 * «He perdido mi NFC» (maqueta 5.2): el cliente bloquea él mismo su NFC
 * (tarjeta, ficha o pulsera) desde su saldo desbloqueado, confirmando con su
 * passkey. El NFC deja de pagar al momento (también sin PIN); el saldo sigue
 * valiendo con su código + PIN o su Face ID, y en recepción le dan un NFC
 * nuevo. Queda en el registro y sale en Incidencias del local que dio el NFC.
 * Sin passkey no se hace aquí (con solo el enlace no se toca el NFC de nadie).
 */
@Injectable()
export class WalletLostCardService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
  ) {}

  /** Reto para la passkey, atado a esta acción y a este saldo. */
  async challenge(walletId: string, host: string | undefined): Promise<unknown> {
    if (!(await this.passkeys.hasPasskey(walletId))) throw faceIdNotSet();
    return this.passkeys.challenge(`card-lost:${walletId}`, host);
  }

  async block(walletId: string, host: string | undefined, response: unknown): Promise<{ blockedCards: number }> {
    if (!(await this.passkeys.hasPasskey(walletId))) throw faceIdNotSet();
    const owner = await this.passkeys.verify(`card-lost:${walletId}`, host, response);
    if (owner !== walletId) throw new ForbiddenException({ message: 'Confirma con el Face ID de este saldo.', code: 'FACE_ID_WRONG' });
    const done = await this.prisma.acrossVenues(async (tx) => {
      // Mismo orden que dar el NFC y la salida de recepción: saldo y después NFC.
      const rows = await tx.$queryRaw<LockedWallet[]>`
        SELECT id, "tenantId", "shortCode", "balanceCents" FROM client_wallets WHERE id = ${walletId}::uuid FOR UPDATE
      `;
      const wallet = rows[0];
      if (!wallet) throw new NotFoundException({ message: 'Saldo no encontrado', code: 'WALLET_NOT_FOUND' });
      const cards = await tx.walletCard.findMany({
        where: { walletId, status: { in: ISSUED_CARD_STATUSES } },
        select: { id: true, venueId: true },
      });
      if (cards.length === 0) return { wallet, cards };
      const now = new Date();
      await tx.walletCard.updateMany({
        where: { id: { in: cards.map((c) => c.id) }, status: { in: ISSUED_CARD_STATUSES } },
        data: { status: 'BLOCKED', blockedAt: now },
      });
      // Cada NFC, con el local que lo dio (los contadores de la noche cuentan eventos).
      for (const card of cards) {
        await recordCardEvents(tx, [{ cardId: card.id, walletId, kind: 'BLOCKED' }], { venueId: card.venueId ?? wallet.tenantId, by: { userId: null }, now });
      }
      return { wallet, cards };
    });
    if (done.cards.length === 0) {
      throw new ConflictException({ message: 'Este saldo ya no tiene ningún NFC activo.', code: 'WALLET_NO_CARD' });
    }
    // La incidencia, al local que dio el NFC: allí le dan uno nuevo.
    await this.audit.log({
      action: CLIENT_CARD_BLOCKED_ACTION,
      tenantId: done.cards[0]!.venueId ?? done.wallet.tenantId,
      actorId: null,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: {
        via: 'client_passkey',
        cards: done.cards.length,
        code: done.wallet.shortCode ? formatWalletCode(done.wallet.shortCode) : null,
        amountCents: done.wallet.balanceCents,
      },
    });
    return { blockedCards: done.cards.length };
  }
}
