import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import type { Redis } from 'ioredis';
import { methodsNeededForPayment, nightSettingsOf, paymentMethodsOf, serviceFeeBpsFor, type CreatePaymentDto, type VenueServiceFee } from '@nightpay/contracts';
import { VENUE_SERVICE_FEE_SELECT, venueServiceFeeOf } from '../payments/service-fee';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { PaymentsService } from '../payments/payments.service';
import { confirmationCode } from '../payments/pay-redirect';
import type { PayLanguage } from '../payments/pay-i18n';
import { VENUE_PAUSE_SELECT, assertVenueNotPaused, venuePauseScope, type VenuePauseState } from '../venues/venue-pause';
import { VENUE_METHODS_SELECT, assertMethodsEnabled } from '../venues/venue-methods';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { eur } from '../../common/money/eur';
import { HOME_TOPUP_KEY_PREFIX } from '../home-topup/home-topup-rules';
import { BASE_GATEWAY_WHERE } from '../gateways/card-gateway';
import {
  FICHA_TOPUP_CAPS,
  FICHA_TOPUP_KEY_PREFIX,
  FICHA_TOPUP_PER_WALLET_MAX,
  SELF_TOPUP_DAILY_MAX_CENTS,
  SELF_TOPUP_DAILY_MAX_PAID,
  SELF_TOPUP_DAILY_WINDOW_MS,
  SELF_TOPUP_KEY_PREFIX,
  SELF_TOPUP_MAX_CENTS,
  SELF_TOPUP_MIN_CENTS,
  SELF_TOPUP_PER_WALLET_MAX,
  SELF_TOPUP_PER_WALLET_WINDOW_S,
  TOPUP_BLOCK_MESSAGES,
  fichaTopUpKey,
  isClientTopUpKey,
  parseTopUpAmount,
  selfTopUpCapProblem,
  selfTopUpClaim,
  selfTopUpKey,
  topUpBlock,
  selfTopUpPresets,
  topUpFeeTable,
  type SelfTopUpCapProblem,
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
  /**
   * % de la «Comisión del servicio» de las recargas (null = sin comisión): la
   * página enseña «Recargas 50 € · Comisión del servicio 6 € · Pagas 56 €».
   */
  serviceFeeBps: number | null;
  /**
   * Esa comisión ya calculada para cada importe que se puede elegir (euros
   * enteros de minCents a maxCents; [i] = la de minCents + i euros), con la
   * misma cuenta que al crear la recarga (topUpFeeTable): la página no la
   * calcula, solo la enseña y pone el total en el botón. null = sin comisión.
   */
  feesCents: number[] | null;
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
  /** «Comisión del servicio» del local del saldo. */
  serviceFee: VenueServiceFee;
  /** Los importes que se ofrecen: los de su recepción (Ajustes → Noche, A9). */
  presetsCents: number[];
}

const OPEN_STATUSES = new Set(['CREATED', 'AUTHORIZING', 'AUTHORIZED']);
const STARTED_MESSAGE = 'Esta recarga ya no vale: vuelve a pulsar «Recargar».';

/** Lo que dice el 409 cuando la recarga no cabe en el tope (code estable para la página). */
const CAP_ERRORS: Readonly<Record<SelfTopUpCapProblem, { code: string; message: string }>> = {
  'daily-amount': {
    code: 'WALLET_TOPUP_DAILY_LIMIT',
    message: `Desde el móvil se recargan como mucho ${eur(SELF_TOPUP_DAILY_MAX_CENTS)} cada 24 h. Pide la recarga en el local.`,
  },
  'daily-count': {
    code: 'WALLET_TOPUP_DAILY_LIMIT',
    message: `Desde el móvil se hacen como mucho ${SELF_TOPUP_DAILY_MAX_PAID} recargas cada 24 h. Pide la recarga en el local.`,
  },
  unresolved: {
    code: 'WALLET_TOPUP_PENDING_LIMIT',
    message: 'Tienes recargas a medias o sin confirmar por el banco: espera unos minutos o pide la recarga en el local.',
  },
};

type RecentTopUp = { id: string; idempotencyKey: string | null; amountCents: number; status: string; qrExpiresAt: Date };

/** El 409 de los topes de «Recargar esta ficha» (B7), con los de /w como código para la página. */
const FICHA_CAP_ERRORS: Readonly<Record<SelfTopUpCapProblem, { code: string; message: string }>> = {
  'daily-amount': {
    code: 'WALLET_TOPUP_DAILY_LIMIT',
    message: `Desde la ficha se recargan como mucho ${eur(FICHA_TOPUP_CAPS.dailyMaxCents)} cada 24 h. Pide la recarga en el local.`,
  },
  'daily-count': {
    code: 'WALLET_TOPUP_DAILY_LIMIT',
    message: `Desde la ficha se hacen como mucho ${FICHA_TOPUP_CAPS.dailyMaxPaid} recargas cada 24 h. Pide la recarga en el local.`,
  },
  unresolved: {
    code: 'WALLET_TOPUP_PENDING_LIMIT',
    message: 'Esta ficha tiene recargas a medias: espera unos minutos o pide la recarga en el local.',
  },
};

/**
 * «Recargar» desde la página del saldo (/w/:token). Crea, con la maquinaria de
 * siempre (PaymentsService.create con wallet.walletId), un cobro de recarga
 * para ESTE saldo en su local, y el cliente lo paga en /pay/:token como
 * cualquier recarga: Apple Pay / Google Pay en el móvil, tarjeta si no. Se suma
 * al saldo al pasar a AUTHORIZED, una sola vez (la máquina de estados), y un
 * segundo pedido aprobado del mismo cobro es la incidencia de doble cobro.
 *
 * Cada «Recargar» es un cobro nuevo que caduca solo si no va al banco (5 min).
 * Uno que se queda en el banco sin respuesta (el cliente cerró la hoja de
 * Apple Pay) lo pregunta la conciliación y, si el banco no lo confirma, queda
 * en ORPHAN (Incidencias) para resolverlo a mano: por eso hay un máximo de
 * recargas a medias o sin confirmar por saldo, además del tope de 24 h
 * (wallet-topup-rules.ts), que se cuenta en la base.
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
      presetsCents: venue.presetsCents,
      minCents: SELF_TOPUP_MIN_CENTS,
      maxCents: SELF_TOPUP_MAX_CENTS,
      serviceFeeBps: serviceFeeBpsFor(venue.serviceFee, 'topUp'),
      feesCents: topUpFeeTable(venue.serviceFee, SELF_TOPUP_MIN_CENTS, SELF_TOPUP_MAX_CENTS),
    };
  }

  /**
   * Saldo con Face ID: reto para su llave antes de recargar (como al sumar a
   * otro saldo). Antes de pedir el Face ID se mira si se puede recargar.
   */
  async challenge(qrToken: string, host: string | undefined): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const wallet = await this.walletOf(qrToken);
    this.assertAllowed(wallet, await this.venueOf(wallet));
    if (!(await this.passkeys.hasPasskey(wallet.id))) {
      throw new ConflictException({ message: 'Este saldo no tiene Face ID', code: 'FACE_ID_NOT_SET' });
    }
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
      throw new BadRequestException({
        message: `La recarga va de ${eur(SELF_TOPUP_MIN_CENTS)} a ${eur(SELF_TOPUP_MAX_CENTS)}, en euros enteros.`,
        code: 'WALLET_TOPUP_AMOUNT',
      });
    }
    if (!isClientTopUpKey(input.key)) {
      throw new BadRequestException({ message: 'Vuelve a abrir la página e inténtalo otra vez.', code: 'PAGE_STALE' });
    }
    const wallet = await this.walletOf(qrToken);
    await this.throttle(wallet.id);
    const venue = await this.venueOf(wallet);
    this.assertAllowed(wallet, venue);
    const claim = selfTopUpClaim(this.config.get<string>('COOKIE_SECRET') ?? '', wallet.id, input.key);
    const key = selfTopUpKey(claim);
    // Tope de 24 h y de recargas a medias, antes de pedir el Face ID (la misma clave repetida ya pasó).
    const replay = await this.assertWithinCap(wallet.id, amountCents, key);
    // Con Face ID, solo quien desbloquea el móvil del saldo (no basta el enlace).
    await this.passkeys.assertOwner(wallet.id, challengeScope(wallet.id), host, input.response);

    // Sin propina: la página de pago no la ofrece en recargas (ni la acepta).
    const dto: CreatePaymentDto = {
      amountCents,
      currency: 'EUR',
      terminalExternalId: venue.terminalExternalId ?? '',
      wallet: { walletId: wallet.id },
    };
    const created = await this.payments().create(wallet.tenantId, key, dto);
    // Dos «Recargar» a la vez (dos pestañas, un script): cada una se mira contra las de antes.
    if (!replay) await this.recheckCap(wallet.id, created.id, amountCents);
    // La misma clave repetida tarde (la página se quedó abierta): ese cobro ya no se paga.
    const stale = !OPEN_STATUSES.has(created.status) || (created.status === 'CREATED' && Date.parse(created.qrExpiresAt) <= Date.now());
    if (stale) throw new ConflictException({ message: STARTED_MESSAGE, code: 'WALLET_TOPUP_STALE' });
    this.logger.log(`Recarga desde /w: wallet=${wallet.id} payment=${created.id} amount=${amountCents}c`);
    return {
      payToken: created.qrToken,
      payUrl: `/pay/${encodeURIComponent(created.qrToken)}?lang=${input.lang}`,
      claim,
    };
  }

  /**
   * «Recargar esta ficha» (B7): la recarga del saldo de la ficha desde el
   * móvil de quien la acerca, sin Face ID y sin enseñar nada del saldo. Solo
   * suma. Con su propio freno (FICHA_TOPUP_*): cada 15 min por saldo y 24 h
   * por saldo, contadas en la base. Al pagar, el «Pagado» de siempre, sin el
   * enlace del saldo (no es la primera recarga ni una de /w).
   */
  async startFromFicha(
    qrToken: string,
    cardId: string,
    input: { amountCents: unknown; key: unknown; lang: PayLanguage },
  ): Promise<{ payUrl: string }> {
    const amountCents = parseTopUpAmount(input.amountCents);
    if (amountCents === null) {
      throw new BadRequestException({
        message: `La recarga va de ${eur(SELF_TOPUP_MIN_CENTS)} a ${eur(SELF_TOPUP_MAX_CENTS)}, en euros enteros.`,
        code: 'WALLET_TOPUP_AMOUNT',
      });
    }
    if (!isClientTopUpKey(input.key)) {
      throw new BadRequestException({ message: 'Vuelve a abrir la página e inténtalo otra vez.', code: 'PAGE_STALE' });
    }
    const wallet = await this.walletOf(qrToken);
    await this.throttle(wallet.id, 'ficha');
    const venue = await this.venueOf(wallet);
    this.assertAllowed(wallet, venue);
    const key = fichaTopUpKey(cardId, input.key);
    const rows = await this.recentTopUps(wallet.id, [FICHA_TOPUP_KEY_PREFIX]);
    const replay = rows.some((r) => r.idempotencyKey === key);
    const problem = replay ? null : selfTopUpCapProblem(rows, amountCents, new Date(), FICHA_TOPUP_CAPS);
    if (problem) throw new ConflictException(FICHA_CAP_ERRORS[problem]);
    const created = await this.payments().create(wallet.tenantId, key, {
      amountCents,
      currency: 'EUR',
      terminalExternalId: venue.terminalExternalId ?? '',
      wallet: { walletId: wallet.id },
    });
    // Varias a la vez (un programa): cada una se mira contra las de antes, como en /w.
    if (!replay) await this.recheckCap(wallet.id, created.id, amountCents, 'ficha');
    const stale = !OPEN_STATUSES.has(created.status) || (created.status === 'CREATED' && Date.parse(created.qrExpiresAt) <= Date.now());
    if (stale) throw new ConflictException({ message: STARTED_MESSAGE, code: 'WALLET_TOPUP_STALE' });
    this.logger.log(`Recarga desde la ficha: wallet=${wallet.id} payment=${created.id} amount=${amountCents}c`);
    return { payUrl: `/pay/${encodeURIComponent(created.qrToken)}?lang=${input.lang}` };
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

  // ─── Tope de 24 h (en la base) ─────────────────────────────────────────

  /**
   * Las recargas del cliente desde su móvil de este saldo de las últimas 24 h
   * (desde /w y la carga desde casa que lo creó, `wcasa:`), de la más antigua
   * a la más nueva: el tope es de lo que se carga sin el personal delante.
   */
  private async recentSelfTopUps(walletId: string): Promise<RecentTopUp[]> {
    return this.recentTopUps(walletId, [SELF_TOPUP_KEY_PREFIX, HOME_TOPUP_KEY_PREFIX]);
  }

  /** Las recargas de las últimas 24 h de este saldo con estas claves (las de /w o las de la ficha). */
  private async recentTopUps(walletId: string, prefixes: readonly string[]): Promise<RecentTopUp[]> {
    const since = new Date(Date.now() - SELF_TOPUP_DAILY_WINDOW_MS);
    return this.prisma.asSystem((tx) =>
      tx.payment.findMany({
        where: {
          walletId,
          OR: prefixes.map((p) => ({ idempotencyKey: { startsWith: p } })),
          createdAt: { gte: since },
        },
        // Por su referencia: el contador del local la da justo antes del commit, así que sigue el orden en que se guardaron.
        orderBy: [{ ref: 'asc' }, { id: 'asc' }],
        select: { id: true, idempotencyKey: true, amountCents: true, status: true, qrExpiresAt: true },
      }),
    );
  }

  /** 409 si no cabe. true = esta clave ya tiene su cobro (doble toque): ese ya pasó el tope. */
  private async assertWithinCap(walletId: string, amountCents: number, key: string): Promise<boolean> {
    const rows = await this.recentSelfTopUps(walletId);
    if (rows.some((r) => r.idempotencyKey === key)) return true;
    const problem = selfTopUpCapProblem(rows, amountCents, new Date());
    if (problem) throw new ConflictException(CAP_ERRORS[problem]);
    return false;
  }

  /**
   * Con el cobro ya creado, el tope contra las recargas de ANTES de esta (por
   * orden de guardado): de dos a la vez que no caben, la segunda se cancela.
   * Desde la ficha, con las suyas y sus topes (FICHA_TOPUP_*).
   */
  private async recheckCap(walletId: string, paymentId: string, amountCents: number, from: 'self' | 'ficha' = 'self'): Promise<void> {
    const ficha = from === 'ficha';
    const rows = ficha ? await this.recentTopUps(walletId, [FICHA_TOPUP_KEY_PREFIX]) : await this.recentSelfTopUps(walletId);
    const mine = rows.findIndex((r) => r.id === paymentId);
    const problem = selfTopUpCapProblem(mine < 0 ? rows : rows.slice(0, mine), amountCents, new Date(), ficha ? FICHA_TOPUP_CAPS : undefined);
    if (!problem) return;
    try {
      await this.payments().transition(paymentId, { type: 'CANCELED', reason: 'wallet-topup-cap' });
    } catch (err) {
      this.logger.warn(`Recarga desde ${ficha ? 'la ficha' : '/w'} ${paymentId} fuera del tope sin cancelar: ${(err as Error).message}`);
    }
    throw new ConflictException((ficha ? FICHA_CAP_ERRORS : CAP_ERRORS)[problem]);
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
        select: { ...VENUE_PAUSE_SELECT, ...VENUE_METHODS_SELECT, ...VENUE_SERVICE_FEE_SELECT, nightSettings: true },
      });
      const gateways = await tx.gatewayCredential.count({ where: { tenantId: wallet.tenantId, ...BASE_GATEWAY_WHERE } });
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
        serviceFee: venueServiceFeeOf(venue),
        presetsCents: selfTopUpPresets(nightSettingsOf(venue?.nightSettings).receptionQuickAmountsCents),
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

  /**
   * Como mucho unas pocas recargas empezadas por saldo cada 15 min (además del
   * límite por IP). Sin Redis no se recarga desde el móvil (503): sin este
   * límite quedaría solo el de la IP (fail-closed; el tope de 24 h va aparte).
   */
  private async throttle(walletId: string, from: 'self' | 'ficha' = 'self'): Promise<void> {
    const key = from === 'ficha' ? `np:ficha-topup:${walletId}` : `np:wallet-topup:${walletId}`;
    const max = from === 'ficha' ? FICHA_TOPUP_PER_WALLET_MAX : SELF_TOPUP_PER_WALLET_MAX;
    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, SELF_TOPUP_PER_WALLET_WINDOW_S);
    } catch (err) {
      this.logger.warn(`Recarga desde /w sin Redis (no se deja recargar): ${(err as Error).message}`);
      throw new ServiceUnavailableException({
        message: 'Ahora no se puede recargar desde el móvil: inténtalo en unos minutos o pide la recarga en el local.',
        code: 'TRY_LATER',
      });
    }
    if (count > max) {
      throw new HttpException(
        { message: 'Demasiadas recargas seguidas: espera unos minutos y vuelve a probar.', code: 'WALLET_TOPUP_TOO_MANY' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/** El reto del Face ID va atado a recargar ESTE saldo. */
function challengeScope(walletId: string): string {
  return `topup:${walletId}`;
}
