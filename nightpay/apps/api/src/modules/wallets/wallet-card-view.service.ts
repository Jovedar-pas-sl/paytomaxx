import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isWalletCardToken } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isIssuedCard } from './wallet-card-ops';
import { WalletPasskeysService } from './wallet-passkeys.service';

/** Leen la ficha clientes sin sesión de personal: la passkey es obligatoria, incluso con saldo cero. */
@Injectable()
export class WalletCardViewService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
  ) {}

  private async target(token: string) {
    const card = isWalletCardToken(token) ? await this.prisma.acrossVenues((tx) => tx.walletCard.findUnique({
      where: { token },
      select: { id: true, status: true, walletId: true, wallet: { select: { id: true, qrToken: true, status: true, blockedAt: true } } },
    })) : null;
    if (!card || !isIssuedCard(card) || !card.wallet || card.wallet.blockedAt || !['ACTIVE', 'DEPLETED'].includes(card.wallet.status)) {
      throw new NotFoundException('Esta ficha no está disponible. Consulta en recepción.');
    }
    return { cardId: card.id, wallet: card.wallet };
  }

  async challenge(token: string, host: string | undefined): Promise<unknown> {
    const t = await this.target(token);
    if (!(await this.passkeys.hasPasskey(t.wallet.id))) {
      throw new ConflictException({ message: 'Activa el desbloqueo desde el enlace privado de tu recarga o pide ayuda en recepción.', code: 'FACE_ID_NOT_SET' });
    }
    return this.passkeys.challenge(`card-view:${t.cardId}:${t.wallet.id}`, host);
  }

  async unlock(token: string, host: string | undefined, response: unknown): Promise<{ id: string; qrToken: string }> {
    const t = await this.target(token);
    // verify es obligatorio: assertOwner permite no tener passkey en otros flujos.
    const owner = await this.passkeys.verify(`card-view:${t.cardId}:${t.wallet.id}`, host, response);
    if (owner !== t.wallet.id) throw new ForbiddenException({ message: 'Usa la passkey de este saldo.', code: 'FACE_ID_WRONG' });
    // Una ficha puede devolverse, bloquearse o reasignarse mientras el cliente confirma.
    const current = await this.target(token);
    if (current.cardId !== t.cardId || current.wallet.id !== owner) throw new ForbiddenException({ message: 'La ficha ha cambiado. Vuelve a acercarla.', code: 'FACE_ID_WRONG' });
    return { id: current.wallet.id, qrToken: current.wallet.qrToken };
  }
}
