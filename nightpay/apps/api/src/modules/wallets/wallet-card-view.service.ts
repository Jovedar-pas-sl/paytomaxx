import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isWalletCardToken } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PayLanguage } from '../payments/pay-i18n';
import { isIssuedCard } from './wallet-card-ops';
import { WalletChargesService, codeHintOf } from './wallet-charges.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { WalletTopUpService, type TopUpOptions } from './wallet-topup.service';
import type { WalletUnlockView } from './wallet-unlock-page';

/** «Ver mi saldo con mi PIN» (B7): lo que dura la vista (sin pagos). */
export const CARD_PIN_VIEW_MS = 10 * 60 * 1000;

/** Lo que ve quien puso bien el PIN de la ficha: el saldo, hasta cuándo y con qué pedirlo otra vez. */
export interface CardPinView {
  balanceCents: number;
  expiresAt: string;
  /** Para «Actualizar» sin volver a teclear el PIN (vale hasta expiresAt; no paga nada). */
  viewToken: string;
}

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
    @Inject(WalletTopUpService) private readonly topUps: WalletTopUpService,
    @Inject(WalletChargesService) private readonly charges: WalletChargesService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private find(token: string) {
    if (!isWalletCardToken(token)) return Promise.resolve(null);
    return this.prisma.acrossVenues((tx) => tx.walletCard.findUnique({
      where: { token },
      select: {
        id: true,
        status: true,
        walletId: true,
        wallet: { select: { id: true, tenantId: true, qrToken: true, status: true, blockedAt: true, shortCode: true, pinHash: true } },
      },
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
    // B7: recargar la ficha (solo suma) y ver el saldo con el PIN, si lo tiene.
    const extra = { topUp: await this.topUpOptions(card.wallet.qrToken), hasPin: Boolean(card.wallet.pinHash) };
    return (await this.passkeys.hasPasskey(card.wallet.id)) ? { kind: 'locked', codeHint, ...extra } : { kind: 'setup', codeHint, ...extra };
  }

  /** Lo que se puede recargar desde la ficha (null: no se puede ahora). */
  private async topUpOptions(qrToken: string): Promise<TopUpOptions | null> {
    try {
      const options = await this.topUps.options(qrToken);
      return options.allowed ? options : null;
    } catch {
      // Sin poder mirarlo (el local, la pasarela…): la página sale sin «Recargar esta ficha».
      return null;
    }
  }

  /** «Recargar esta ficha» (B7): a la página de pago de siempre; sin ver el saldo ni su enlace. */
  async startTopUp(token: string, input: { amountCents: unknown; key: unknown; lang: PayLanguage }): Promise<{ payUrl: string }> {
    const t = await this.target(token);
    return this.topUps.startFromFicha(t.wallet.qrToken, t.cardId, input);
  }

  /**
   * «Ver mi saldo con mi PIN» (B7): con el PIN bien (el mismo contador de
   * fallos: 5 y el saldo se bloquea), el saldo durante CARD_PIN_VIEW_MS. Nada
   * para pagar ni el enlace del saldo; tampoco activa Face ID.
   */
  async viewWithPin(token: string, pin: unknown, now: Date = new Date()): Promise<CardPinView> {
    if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) throw new BadRequestException({ message: 'El PIN son 4 cifras.', code: 'PIN_FORMAT' });
    const t = await this.target(token);
    if (!t.wallet.pinHash) throw new ConflictException({ message: 'Esta ficha aún no tiene PIN.', code: 'CARD_NO_PIN' });
    await this.charges.checkPinForCardView(t.wallet.id, t.wallet.tenantId, pin);
    const exp = now.getTime() + CARD_PIN_VIEW_MS;
    return this.pinView(t, exp);
  }

  /** «Actualizar» dentro de los 10 min, sin volver a teclear el PIN. */
  async viewAgain(token: string, viewToken: unknown, now: Date = new Date()): Promise<CardPinView> {
    const t = await this.target(token);
    const parts = typeof viewToken === 'string' ? viewToken.split('.') : [];
    const exp = Number(parts[0]);
    if (parts.length !== 2 || !Number.isSafeInteger(exp) || exp <= now.getTime() || exp > now.getTime() + CARD_PIN_VIEW_MS) {
      throw new ForbiddenException({ message: 'Han pasado 10 minutos: vuelve a poner tu PIN.', code: 'CARD_VIEW_EXPIRED' });
    }
    const expected = Buffer.from(this.viewSignature(t.cardId, t.wallet.id, exp));
    const given = Buffer.from(parts[1] ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new ForbiddenException({ message: 'Han pasado 10 minutos: vuelve a poner tu PIN.', code: 'CARD_VIEW_EXPIRED' });
    }
    return this.pinView(t, exp);
  }

  private async pinView(t: { cardId: string; wallet: { id: string } }, exp: number): Promise<CardPinView> {
    const wallet = await this.prisma.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: t.wallet.id }, select: { balanceCents: true, status: true } }));
    return {
      balanceCents: wallet?.status === 'ACTIVE' ? Math.max(0, wallet.balanceCents) : 0,
      expiresAt: new Date(exp).toISOString(),
      viewToken: `${exp}.${this.viewSignature(t.cardId, t.wallet.id, exp)}`,
    };
  }

  /** Atada a esta ficha, a su saldo y a su hora de fin: con la ficha devuelta o dada a otro, ya no vale. */
  private viewSignature(cardId: string, walletId: string, exp: number): string {
    const secret = this.config.get<string>('COOKIE_SECRET') ?? '';
    return createHmac('sha256', secret).update(`card-pin-view:${cardId}:${walletId}:${exp}`).digest('base64url');
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
