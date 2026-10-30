import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { paymentMethodsOf } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { fichaQrSvg } from './ficha-qr';
import { rememberSetCookie } from './home-topup-rules';

/**
 * Lo que «Cargar saldo antes de llegar» añade a la página del saldo (/w):
 *  - el QR de la ficha (para que recepción le dé una ficha unida a su saldo),
 *    si el saldo está activo, aún no tiene ficha y el local da fichas;
 *  - la cookie con la que el enlace del local sabe que este navegador ya
 *    tiene un saldo de allí (home-topup-rules: su id firmado, nunca el enlace).
 * Lo usa PublicWalletController (lo registra WalletsModule).
 */
@Injectable()
export class WalletWelcomeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /** El QR de la ficha en SVG, o null si no toca (con ficha, cerrado, sumado, bloqueado o sin fichas en el local). */
  async fichaQr(qrToken: string, state: { hasCard: boolean; status: string; merged: boolean }): Promise<string | null> {
    if (state.hasCard || state.status !== 'ACTIVE' || state.merged) return null;
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({
        where: { qrToken },
        select: {
          id: true,
          shortCode: true,
          blockedAt: true,
          closeRequestedAt: true,
          pendingAssignAt: true,
          venue: { select: { paymentMethods: true } },
        },
      }),
    );
    if (!wallet?.shortCode || wallet.blockedAt || wallet.closeRequestedAt || wallet.pendingAssignAt) return null;
    if (!paymentMethodsOf(wallet.venue.paymentMethods).nfc) return null;
    return fichaQrSvg({ secret: this.secret(), wallet: { id: wallet.id, qrToken }, code: wallet.shortCode });
  }

  /** Set-Cookie para que el enlace del local recuerde este saldo (con su enlace de ahora) en este navegador. */
  rememberCookie(wallet: { id: string; qrToken: string }, cookies: string | undefined): string | null {
    return rememberSetCookie(this.secret(), wallet, cookies);
  }

  private secret(): string {
    return this.config.get<string>('COOKIE_SECRET') ?? '';
  }
}
