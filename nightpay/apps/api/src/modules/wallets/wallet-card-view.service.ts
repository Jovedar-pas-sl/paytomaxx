import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isWalletCardToken } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isIssuedCard } from './wallet-card-ops';
import { codeHintOf } from './wallet-charges.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import type { WalletUnlockView } from './wallet-unlock-page';

const SETUP_MESSAGE = 'Para ver tu saldo en tu móvil, pide en recepción el QR de activación.';

/**
 * Leen la ficha clientes sin sesión de personal: la passkey es obligatoria,
 * incluso con saldo cero. Sin passkey, la página dice cómo activarla (QR de
 * activación en recepción): con la ficha sola nunca se registra una passkey,
 * porque esa passkey también paga.
 */
@Injectable()
export class WalletCardViewService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
  ) {}

  private find(token: string) {
    if (!isWalletCardToken(token)) return Promise.resolve(null);
    return this.prisma.acrossVenues((tx) => tx.walletCard.findUnique({
      where: { token },
      select: { id: true, status: true, walletId: true, wallet: { select: { id: true, qrToken: true, status: true, blockedAt: true, shortCode: true } } },
    }));
  }

  private async target(token: string) {
    const card = await this.find(token);
    if (!card || !isIssuedCard(card) || !card.wallet || card.wallet.blockedAt || !['ACTIVE', 'DEPLETED'].includes(card.wallet.status)) {
      throw new NotFoundException('Esta ficha no está disponible. Consulta en recepción.');
    }
    return { cardId: card.id, wallet: card.wallet };
  }

  /** La pantalla de /w/card/<ficha>: con passkey, desbloquear; sin ella, cómo activarla; si no, por qué no vale. */
  async pageView(token: string): Promise<WalletUnlockView> {
    const card = await this.find(token);
    if (card?.status === 'BLOCKED') return { kind: 'blocked' };
    if (!card || !isIssuedCard(card) || !card.wallet || card.wallet.blockedAt || !['ACTIVE', 'DEPLETED'].includes(card.wallet.status)) {
      return { kind: 'unavailable' };
    }
    const codeHint = card.wallet.shortCode ? codeHintOf(card.wallet.shortCode) : null;
    return (await this.passkeys.hasPasskey(card.wallet.id)) ? { kind: 'locked', codeHint } : { kind: 'setup', codeHint };
  }

  async challenge(token: string, host: string | undefined): Promise<unknown> {
    const t = await this.target(token);
    if (!(await this.passkeys.hasPasskey(t.wallet.id))) {
      throw new ConflictException({ message: SETUP_MESSAGE, code: 'FACE_ID_NOT_SET' });
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
    if (current.cardId !== t.cardId || current.wallet.id !== owner || current.wallet.qrToken !== t.wallet.qrToken) {
      throw new ForbiddenException({ message: 'La ficha o el enlace del saldo han cambiado. Vuelve a acercarla.', code: 'FACE_ID_WRONG' });
    }
    return { id: current.wallet.id, qrToken: current.wallet.qrToken };
  }
}
