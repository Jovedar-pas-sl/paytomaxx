import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { activationPath, issueActivationToken } from '../wallets/wallet-activation-token';
import { GIFT_PAID_STATUSES, giftState, isGiftToken, type GiftState } from './home-topup-gift';
import type { GiftPageView } from './home-topup-gift-page';
import { LOCAL_API_ORIGIN, originOf } from './home-topup-settings.service';

const PAID = new Set<string>(GIFT_PAID_STATUSES);

/** «Guardar en mi móvil»: a dónde va el móvil (el QR de activación), o por qué no. */
export type GiftClaim = { activationPath: string } | { state: Exclude<GiftState, 'open'> };

/**
 * «Regala una noche»: la página del regalo y «Guardar en mi móvil». El enlace
 * del regalo es un token al azar (no el del saldo). Mirar no cambia nada;
 * guardar emite el QR de activación de siempre (/w/a, via 'gift', 10 min, un
 * solo uso: anula el anterior sin usar) y, al gastarse con el Face ID o el
 * PIN de quien lo recibe, el regalo queda guardado en la misma transacción
 * (WalletActivationUseService): desde entonces el enlace ya no da nada.
 * Un regalo ya pagado se guarda aunque el dueño apague «Regalos» después.
 */
@Injectable()
export class HomeTopUpGiftService {
  private readonly logger = new Logger(HomeTopUpGiftService.name);
  /** El origen del API (para el enlace entero que se comparte). */
  readonly origin: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.origin = originOf(config.get<string>('NEXT_PUBLIC_API_URL')) ?? LOCAL_API_ORIGIN;
  }

  /** La página del regalo; null = 404 (no existe, sin pagar o el local ya no está). */
  async view(token: string, now: Date = new Date()): Promise<GiftPageView | null> {
    if (!isGiftToken(token)) return null;
    const gift = await this.prisma.asSystem((tx) => this.find(tx, token));
    if (!gift) return null;
    return {
      state: stateOf(gift, now),
      venueName: gift.venue.name,
      amountCents: gift.payment.amountCents,
      toName: gift.toName,
      message: gift.message,
      expiresAt: gift.expiresAt,
    };
  }

  /** «Guardar en mi móvil»: el QR de activación para ESTE móvil (null = 404). */
  async claim(token: string, now: Date = new Date()): Promise<GiftClaim | null> {
    if (!isGiftToken(token)) return null;
    return this.prisma.asSystem(async (tx) => {
      const first = await this.find(tx, token);
      if (!first) return null;
      // Con el saldo bloqueado (como al activarlo) y leído otra vez: si se acaba de
      // guardar con otro QR, se ve aquí y no se emite otro.
      await tx.$queryRaw`SELECT id FROM client_wallets WHERE id = ${first.walletId}::uuid FOR UPDATE`;
      const gift = await this.find(tx, token);
      if (!gift) return null;
      const state = stateOf(gift, now);
      if (state !== 'open') return { state };
      const issued = await issueActivationToken(tx, { walletId: gift.walletId, venueId: gift.tenantId, issuedById: null, via: 'gift', now });
      this.logger.log(`Regalo: QR de activación emitido (venue=${gift.tenantId} wallet=${gift.walletId})`);
      return { activationPath: activationPath(issued.token) };
    });
  }

  /** El regalo pagado de un local que sigue abierto (con el saldo, para saber si ya se activó). */
  private async find(tx: TransactionalClient, token: string) {
    const gift = await tx.walletGift.findUnique({
      where: { token },
      select: {
        tenantId: true,
        walletId: true,
        toName: true,
        message: true,
        expiresAt: true,
        claimedAt: true,
        venue: { select: { name: true, deletedAt: true } },
        payment: { select: { amountCents: true, status: true } },
        wallet: { select: { pinHash: true, _count: { select: { passkeys: true } } } },
      },
    });
    return !gift || gift.venue.deletedAt || !PAID.has(gift.payment.status) ? null : gift;
  }
}

function stateOf(
  g: { claimedAt: Date | null; expiresAt: Date; wallet: { pinHash: string | null; _count: { passkeys: number } } },
  now: Date,
): GiftState {
  return giftState({ claimedAt: g.claimedAt, expiresAt: g.expiresAt, walletActivated: g.wallet.pinHash !== null || g.wallet._count.passkeys > 0 }, now);
}
