import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import type { Redis } from 'ioredis';
import { methodsNeededForPayment, paymentMethodsOf, type CreatePaymentDto } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { PaymentsService } from '../payments/payments.service';
import { confirmationCode } from '../payments/pay-redirect';
import type { PayLanguage } from '../payments/pay-i18n';
import { VENUE_PAUSE_SELECT, assertVenueNotPaused, venuePauseScope, type VenuePauseState } from '../venues/venue-pause';
import { VENUE_METHODS_SELECT, assertMethodsEnabled } from '../venues/venue-methods';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { eur } from './wallet-two-factor';
import {
  SELF_TOPUP_MAX_CENTS,
  SELF_TOPUP_MIN_CENTS,
  SELF_TOPUP_PER_WALLET_MAX,
  SELF_TOPUP_PER_WALLET_WINDOW_S,
  SELF_TOPUP_PRESETS_CENTS,
  TOPUP_BLOCK_MESSAGES,
  isClientTopUpKey,
  parseTopUpAmount,
  selfTopUpClaim,
  selfTopUpKey,
  topUpBlock,
  type TopUpBlock,
  type TopUpVenueState,
  type TopUpWalletState,
} from './wallet-topup-rules';

/** Lo que necesita la página del saldo para enseñar «Recargar». */
export interface TopUpOptions {
  allowed: boolean;
  block: TopUpBlock | null;
  presetsCents: number[];
  minCents: number;
  maxCents: number;
}

export interface TopUpStarted {
  /** Página de pago de siempre (/pay/:token): Apple Pay / Google Pay o tarjeta. */
  payUrl: string;
  payToken: string;
  /** Valor de la cookie de vuelta (la pone el controlador en /pay). */
  claim: string;
}

/** «Pagado» de una recarga de este saldo, para enseñarlo en /w al volver del banco. */
export interface TopUpProof {
  payToken: string;
  amountCents: number;
  authorizedAt: string | null;
  code: string;
}

type TopUpWallet = TopUpWalletState & { id: string; tenantId: string };

interface TopUpVenue {
  state: TopUpVenueState;
  raw: VenuePauseState & { paymentMethods: unknown };
  terminalExternalId: string | null;
}

const OPEN_STATUSES = new Set(['CREATED', 'AUTHORIZING', 'AUTHORIZED']);
const STARTED_MESSAGE = 'Esta recarga ya no vale: vuelve a pulsar «Recargar».';

/**
 * «Recargar» desde la página del saldo (/w/:token). Crea, con la maquinaria de
 * siempre (PaymentsService.create con wallet.walletId), un cobro de recarga
 * para ESTE saldo en su local, y el cliente lo paga en /pay/:token como
 * cualquier recarga: Apple Pay / Google Pay en el móvil, tarjeta si no. Se suma
 * al saldo al pasar a AUTHORIZED, una sola vez (la máquina de estados), y un
 * segundo pedido aprobado del mismo cobro es la incidencia de doble cobro.
 *
 * No deja nada a medias: cada «Recargar» es un cobro nuevo que caduca solo (5
 * min sin ir al banco; uno que se queda en el banco lo cierra la
 * conciliación), y ninguno pendiente impide empezar otro.
 *
 * PaymentsService con ModuleRef: PaymentsModule ya importa WalletsModule.
 */
@Injectable()
export class WalletTopUpService {
  private readonly logger = new Logger(WalletTopUpService.name);
  private readonly prisma: PrismaService;
  private readonly passkeys: WalletPasskeysService;
  private readonly redis: Redis;
  private readonly config: ConfigService;
  private readonly moduleRef: ModuleRef;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(WalletPasskeysService) passkeys: WalletPasskeysService,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(ConfigService) config: ConfigService,
    @Inject(ModuleRef) moduleRef: ModuleRef,
  ) {
    this.prisma = prisma;
    this.passkeys = passkeys;
    this.redis = redis;
    this.config = config;
    this.moduleRef = moduleRef;
  }

  /** ¿Se puede recargar este saldo ahora? Con los importes que se ofrecen. */
  async options(qrToken: string): Promise<TopUpOptions> {
    const wallet = await this.walletOf(qrToken);
    const venue = await this.venueOf(wallet);
    const block = topUpBlock(wallet, venue.state);
    return {
      allowed: block === null,
      block,
      presetsCents: [...SELF_TOPUP_PRESETS_CENTS],
      minCents: SELF_TOPUP_MIN_CENTS,
      maxCents: SELF_TOPUP_MAX_CENTS,
    };
  }

  /**
   * Saldo con Face ID: reto para su llave antes de recargar (como al sumar a
   * otro saldo). Antes de pedir el Face ID se mira si se puede recargar.
   */
  async challenge(qrToken: string, host: string | undefined): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const wallet = await this.walletOf(qrToken);
    this.assertAllowed(wallet, await this.venueOf(wallet));
    if (!(await this.passkeys.hasPasskey(wallet.id))) throw new ConflictException('Este saldo no tiene Face ID');
    return this.passkeys.challenge(challengeScope(wallet.id), host);
  }

  /** Crea la recarga y devuelve a dónde ir a pagarla. */
  async start(
    qrToken: string,
    input: { amountCents: unknown; key: unknown; response?: unknown; lang: PayLanguage },
    host: string | undefined,
  ): Promise<TopUpStarted> {
    const amountCents = parseTopUpAmount(input.amountCents);
    if (amountCents === null) {
      throw new BadRequestException(
        `La recarga va de ${eur(SELF_TOPUP_MIN_CENTS)} a ${eur(SELF_TOPUP_MAX_CENTS)}, en euros enteros.`,
      );
    }
    if (!isClientTopUpKey(input.key)) throw new BadRequestException('Vuelve a abrir la página e inténtalo otra vez.');
    const wallet = await this.walletOf(qrToken);
    await this.throttle(wallet.id);
    const venue = await this.venueOf(wallet);
    this.assertAllowed(wallet, venue);
    // Con Face ID, solo quien desbloquea el móvil del saldo (no basta el enlace).
    if (await this.passkeys.hasPasskey(wallet.id)) {
      const owner = await this.passkeys.verify(challengeScope(wallet.id), host, input.response);
      if (owner !== wallet.id) throw new ForbiddenException('Confirma con el Face ID de este saldo.');
    }

    const claim = selfTopUpClaim(this.config.get<string>('COOKIE_SECRET') ?? '', wallet.id, input.key);
    // Sin propina: la página de pago no la ofrece en recargas (ni la acepta).
    const dto: CreatePaymentDto = {
      amountCents,
      currency: 'EUR',
      terminalExternalId: venue.terminalExternalId ?? '',
      wallet: { walletId: wallet.id },
    };
    const created = await this.payments().create(wallet.tenantId, selfTopUpKey(claim), dto);
    // La misma clave repetida tarde (la página se quedó abierta): ese cobro ya no se paga.
    const stale = !OPEN_STATUSES.has(created.status) || (created.status === 'CREATED' && Date.parse(created.qrExpiresAt) <= Date.now());
    if (stale) throw new ConflictException(STARTED_MESSAGE);
    this.logger.log(`Recarga desde /w: wallet=${wallet.id} payment=${created.id} amount=${amountCents}c`);
    return {
      payToken: created.qrToken,
      payUrl: `/pay/${encodeURIComponent(created.qrToken)}?lang=${input.lang}`,
      claim,
    };
  }

  /** El «Pagado» de una recarga de ESTE saldo (otro cobro u otro saldo: null). */
  async paidProof(qrToken: string, payToken: string | undefined): Promise<TopUpProof | null> {
    if (!payToken || payToken.length > 64) return null;
    const found = await this.prisma.asSystem(async (tx) => {
      const wallet = await tx.clientWallet.findUnique({ where: { qrToken }, select: { id: true } });
      const payment = await tx.payment.findUnique({
        where: { qrToken: payToken },
        select: { id: true, walletId: true, status: true, amountCents: true, authorizedAt: true },
      });
      return { wallet, payment };
    });
    const { wallet, payment } = found;
    if (!wallet || !payment || payment.walletId !== wallet.id || payment.status !== 'AUTHORIZED') return null;
    return {
      payToken,
      amountCents: payment.amountCents,
      authorizedAt: payment.authorizedAt?.toISOString() ?? null,
      code: confirmationCode(payment.id),
    };
  }

  // ─── Auxiliares ────────────────────────────────────────────────────────

  private payments(): PaymentsService {
    return this.moduleRef.get(PaymentsService, { strict: false });
  }

  private async walletOf(qrToken: string): Promise<TopUpWallet> {
    const wallet = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findUnique({
        where: { qrToken },
        select: { id: true, tenantId: true, status: true, blockedAt: true, mergedIntoId: true, closeRequestedAt: true },
      }),
    );
    if (!wallet) throw new NotFoundException('Saldo no encontrado');
    return wallet;
  }

  /**
   * El local del saldo: pausa, formas de cobro, pasarela y datáfono al que se
   * apunta la recarga (el de la última recarga de este saldo si sigue activo;
   * si no, el primero activo del local, como el personal al elegir zona).
   */
  private async venueOf(wallet: TopUpWallet): Promise<TopUpVenue> {
    return this.prisma.asSystem(async (tx) => {
      const venue = await tx.venue.findUnique({
        where: { id: wallet.tenantId },
        select: { ...VENUE_PAUSE_SELECT, ...VENUE_METHODS_SELECT },
      });
      const gateways = await tx.gatewayCredential.count({ where: { tenantId: wallet.tenantId, active: true } });
      const last = await tx.payment.findFirst({
        where: { walletId: wallet.id, tenantId: wallet.tenantId },
        orderBy: { createdAt: 'desc' },
        select: { terminal: { select: { externalId: true, active: true } } },
      });
      const fallback = last?.terminal.active
        ? null
        : await tx.terminal.findFirst({
            where: { tenantId: wallet.tenantId, active: true },
            orderBy: { externalId: 'asc' },
            select: { externalId: true },
          });
      const terminalExternalId = last?.terminal.active ? last.terminal.externalId : (fallback?.externalId ?? null);
      const methods = paymentMethodsOf(venue?.paymentMethods);
      return {
        state: {
          paused: venuePauseScope(venue) !== null,
          card: methods.card,
          wallet: methods.wallet,
          hasGateway: gateways > 0,
          hasTerminal: terminalExternalId !== null,
        },
        raw: { pausedAt: venue?.pausedAt ?? null, business: venue?.business ?? null, paymentMethods: venue?.paymentMethods },
        terminalExternalId,
      };
    });
  }

  /** 423 si el local está en pausa, 409 si la forma de cobro está apagada o el saldo no admite recargas. */
  private assertAllowed(wallet: TopUpWallet, venue: TopUpVenue): void {
    const block = topUpBlock(wallet, venue.state);
    if (block === null) return;
    if (block === 'paused') assertVenueNotPaused(venue.raw);
    if (block === 'method-off') {
      assertMethodsEnabled(venue.raw, methodsNeededForPayment({ isWalletTopUp: true, isPosExternal: false }));
    }
    throw new ConflictException({ message: TOPUP_BLOCK_MESSAGES[block], code: 'WALLET_TOPUP_UNAVAILABLE', reason: block });
  }

  /** Como mucho unas pocas recargas empezadas por saldo cada 15 min (además del límite por IP). */
  private async throttle(walletId: string): Promise<void> {
    const key = `np:wallet-topup:${walletId}`;
    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, SELF_TOPUP_PER_WALLET_WINDOW_S);
    } catch (err) {
      // Sin Redis no se bloquea al cliente: queda el límite por IP.
      this.logger.warn(`Recarga desde /w: límite por saldo sin Redis: ${(err as Error).message}`);
      return;
    }
    if (count > SELF_TOPUP_PER_WALLET_MAX) {
      throw new HttpException(
        'Demasiadas recargas seguidas: espera unos minutos y vuelve a probar.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/** El reto del Face ID va atado a recargar ESTE saldo. */
function challengeScope(walletId: string): string {
  return `topup:${walletId}`;
}
