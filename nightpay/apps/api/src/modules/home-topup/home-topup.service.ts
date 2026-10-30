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
import type { Redis } from 'ioredis';
import {
  methodsNeededForPayment,
  paymentMethodsOf,
  serviceFeeBpsFor,
  type CreatePaymentDto,
  type HomeTopUpProblem,
  type VenueServiceFee,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { PaymentsService } from '../payments/payments.service';
import type { PayLanguage } from '../payments/customer-lang';
import { VENUE_SERVICE_FEE_SELECT, venueServiceFeeOf } from '../payments/service-fee';
import { VENUE_METHODS_SELECT, assertMethodsEnabled } from '../venues/venue-methods';
import { VENUE_PAUSE_SELECT, assertVenueNotPaused, venuePauseScope, type VenuePauseState } from '../venues/venue-pause';
import type { VenueServiceFeeRow } from '../payments/service-fee';
import { codeHintOf } from '../wallets/wallet-charges.service';
import { eur } from '../wallets/wallet-two-factor';
import {
  SELF_TOPUP_MAX_CENTS,
  SELF_TOPUP_MIN_CENTS,
  SELF_TOPUP_PRESETS_CENTS,
  isClientTopUpKey,
  parseTopUpAmount,
  topUpFeeTable,
  type TopUpVenueState,
} from '../wallets/wallet-topup-rules';
import {
  HOME_TOPUP_KEY_PREFIX,
  HOME_TOPUP_UNRESOLVED_WINDOW_MS,
  HOME_TOPUP_VENUE_MAX,
  HOME_TOPUP_VENUE_MAX_UNRESOLVED,
  HOME_TOPUP_VENUE_WINDOW_S,
  homeTopUpKey,
  homeTopUpProblem,
  isHomeTopUpCode,
  rememberedWalletIds,
} from './home-topup-rules';

/** El local de un enlace encendido, con lo que hace falta para cargar. */
export interface HomeVenue {
  id: string;
  name: string;
  state: TopUpVenueState;
  raw: VenuePauseState & { paymentMethods: unknown };
  terminalExternalId: string | null;
  serviceFee: VenueServiceFee;
}

/** Lo que pinta la página del enlace (/r/<código>). */
export interface HomeTopUpPageView {
  venueName: string;
  problem: HomeTopUpProblem | null;
  presetsCents: number[];
  minCents: number;
  maxCents: number;
  /** % de la comisión del servicio de las recargas (null: sin comisión). */
  serviceFeeBps: number | null;
  /** Esa comisión ya calculada para cada importe (como en «Recargar»: la página no la calcula). */
  feesCents: number[] | null;
  /** Este navegador ya tiene un saldo de este local: su código tapado (K7Q-•••). */
  mine: { codeHint: string } | null;
}

export interface HomeTopUpStarted {
  payToken: string;
  /** La página de pago de siempre (/pay/:token): Apple Pay / Google Pay o tarjeta. */
  payUrl: string;
}

/** 404 sin pistas: no existe, está apagado o el código cambió (todo igual). */
export const HOME_TOPUP_GONE_MESSAGE = 'Este enlace no existe o ya no vale';
export function homeTopUpGone(): NotFoundException {
  return new NotFoundException({ message: HOME_TOPUP_GONE_MESSAGE, code: 'HOME_TOPUP_GONE' });
}

const OPEN_STATUSES = new Set(['CREATED', 'AUTHORIZING', 'AUTHORIZED']);
const LIVE = new Set(['ACTIVE', 'DEPLETED']);

/**
 * «Cargar saldo antes de llegar»: la página del enlace del local y la carga.
 * La carga es una recarga con tarjeta de un saldo NUEVO (PaymentsService.create
 * con wallet.create, la maquinaria de siempre: el saldo se crea con el cobro y
 * se suma al pasar a AUTHORIZED, una sola vez), sin persona del local (nadie
 * cobra comisión por ella) y con la Idempotency-Key `wcasa:` (home-topup-rules).
 * El cliente la paga en /pay/:token como cualquier recarga y, al pagar, su
 * navegador va a su saldo nuevo (payerWalletFields → walletFromHome).
 * Si el navegador ya tiene un saldo de este local, la página ofrece recargarlo
 * (en su página del saldo, «Recargar», con sus topes y su Face ID).
 */
@Injectable()
export class HomeTopUpService {
  private readonly logger = new Logger(HomeTopUpService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /** El local de este enlace si está encendido; si no (o el código no tiene forma), null. */
  async venueByCode(code: string): Promise<HomeVenue | null> {
    if (!isHomeTopUpCode(code)) return null;
    return this.prisma.asSystem(async (tx) => {
      const venue = await tx.venue.findUnique({
        where: { homeTopUpCode: code },
        select: {
          id: true,
          name: true,
          homeTopUpEnabled: true,
          deletedAt: true,
          ...VENUE_PAUSE_SELECT,
          ...VENUE_METHODS_SELECT,
          ...VENUE_SERVICE_FEE_SELECT,
        },
      });
      if (!venue || !venue.homeTopUpEnabled || venue.deletedAt) return null;
      return this.withState(tx, venue);
    });
  }

  /** Lo mismo por el id del local (Ajustes del dueño: si deja cargar ahora). */
  async venueState(venueId: string): Promise<HomeVenue | null> {
    return this.prisma.asSystem(async (tx) => {
      const venue = await tx.venue.findUnique({
        where: { id: venueId },
        select: { id: true, name: true, ...VENUE_PAUSE_SELECT, ...VENUE_METHODS_SELECT, ...VENUE_SERVICE_FEE_SELECT },
      });
      return venue ? this.withState(tx, venue) : null;
    });
  }

  /** La página: importes, comisión y, si este navegador ya tiene un saldo de aquí, ese. null = 404. */
  async page(code: string, cookies: string | undefined): Promise<HomeTopUpPageView | null> {
    const venue = await this.venueByCode(code);
    if (!venue) return null;
    const mine = await this.rememberedWallet(venue.id, cookies);
    return {
      venueName: venue.name,
      problem: homeTopUpProblem(venue.state),
      presetsCents: [...SELF_TOPUP_PRESETS_CENTS],
      minCents: SELF_TOPUP_MIN_CENTS,
      maxCents: SELF_TOPUP_MAX_CENTS,
      serviceFeeBps: serviceFeeBpsFor(venue.serviceFee, 'topUp'),
      feesCents: topUpFeeTable(venue.serviceFee, SELF_TOPUP_MIN_CENTS, SELF_TOPUP_MAX_CENTS),
      mine: mine ? { codeHint: codeHintOf(mine.shortCode) } : null,
    };
  }

  /** «Recargar mi saldo»: la página del saldo que recuerda este navegador, en «Recargar» (null: no tiene). */
  async mySaldoHref(code: string, cookies: string | undefined, lang: PayLanguage): Promise<string | null> {
    const venue = await this.venueByCode(code);
    if (!venue) return null;
    const mine = await this.rememberedWallet(venue.id, cookies);
    return mine ? `/w/${encodeURIComponent(mine.qrToken)}?lang=${lang}#recargar` : null;
  }

  /** Crea la carga (un saldo nuevo de este local) y dice a dónde ir a pagarla. */
  async start(code: string, input: { amountCents: unknown; key: unknown; lang: PayLanguage }): Promise<HomeTopUpStarted> {
    const venue = await this.venueByCode(code);
    if (!venue) throw homeTopUpGone();
    const amountCents = parseTopUpAmount(input.amountCents);
    if (amountCents === null) {
      throw new BadRequestException({
        message: `La carga va de ${eur(SELF_TOPUP_MIN_CENTS)} a ${eur(SELF_TOPUP_MAX_CENTS)}, en euros enteros.`,
        code: 'WALLET_TOPUP_AMOUNT',
      });
    }
    if (!isClientTopUpKey(input.key)) {
      throw new BadRequestException({ message: 'Vuelve a abrir la página e inténtalo otra vez.', code: 'PAGE_STALE' });
    }
    this.assertCanLoad(venue);
    const key = homeTopUpKey(this.secret(), venue.id, input.key);
    // La misma clave repetida (doble toque, la red): el mismo cobro, sin gastar otra vez el freno.
    const replay = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId: venue.id, idempotencyKey: key } }, select: { id: true } }),
    );
    if (!replay) {
      await this.throttleVenue(venue.id);
      await this.assertVenueUnresolved(venue.id);
    }
    // Sin propina (la página de pago no la ofrece en recargas) y sin persona: nadie cobra comisión.
    const dto: CreatePaymentDto = {
      amountCents,
      currency: 'EUR',
      terminalExternalId: venue.terminalExternalId ?? '',
      wallet: { create: true },
    };
    const created = await this.payments.create(venue.id, key, dto);
    const stale = !OPEN_STATUSES.has(created.status) || (created.status === 'CREATED' && Date.parse(created.qrExpiresAt) <= Date.now());
    if (stale) throw new ConflictException({ message: 'Esta carga ya no vale: vuelve a pulsar el botón.', code: 'WALLET_TOPUP_STALE' });
    this.logger.log(`Carga desde casa: venue=${venue.id} payment=${created.id} wallet=${created.walletId ?? '-'} amount=${amountCents}c`);
    return { payToken: created.qrToken, payUrl: `/pay/${encodeURIComponent(created.qrToken)}?lang=${input.lang}` };
  }

  // ─── Auxiliares ────────────────────────────────────────────────────

  private secret(): string {
    return this.config.get<string>('COOKIE_SECRET') ?? '';
  }

  /** Pausa, formas de cobro, pasarela y el terminal al que se apunta la carga. */
  private async withState(
    tx: TransactionalClient,
    venue: { id: string; name: string; paymentMethods: unknown } & VenuePauseState & Partial<VenueServiceFeeRow>,
  ): Promise<HomeVenue> {
    const gateways = await tx.gatewayCredential.count({ where: { tenantId: venue.id, active: true } });
    // Uno del local que no sea el datáfono de recepción: sus topes son de lo cobrado allí.
    const terminal = await tx.terminal.findFirst({
      where: { tenantId: venue.id, active: true },
      orderBy: [{ reception: 'asc' }, { externalId: 'asc' }],
      select: { externalId: true },
    });
    const methods = paymentMethodsOf(venue.paymentMethods);
    return {
      id: venue.id,
      name: venue.name,
      state: {
        paused: venuePauseScope(venue) !== null,
        card: methods.card,
        wallet: methods.wallet,
        hasGateway: gateways > 0,
        hasTerminal: terminal !== null,
      },
      raw: { pausedAt: venue.pausedAt, business: venue.business ?? null, paymentMethods: venue.paymentMethods },
      terminalExternalId: terminal?.externalId ?? null,
      serviceFee: venueServiceFeeOf(venue),
    };
  }

  /** 423 en pausa, 409 con la forma de cobro apagada, sin pasarela o sin terminal. */
  private assertCanLoad(venue: HomeVenue): void {
    const problem = homeTopUpProblem(venue.state);
    if (problem === null) return;
    if (problem === 'paused') assertVenueNotPaused(venue.raw);
    if (problem === 'methods') {
      assertMethodsEnabled(venue.raw, methodsNeededForPayment({ isWalletTopUp: true, isPosExternal: false }));
    }
    throw new ConflictException({
      message: 'Ahora no se puede cargar saldo desde aquí. Pregunta en el local.',
      code: 'HOME_TOPUP_UNAVAILABLE',
      reason: problem,
    });
  }

  /** Como mucho HOME_TOPUP_VENUE_MAX cargas empezadas cada 15 min en el local. Sin Redis, no (503). */
  private async throttleVenue(venueId: string): Promise<void> {
    const key = `np:home-topup:venue:${venueId}`;
    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, HOME_TOPUP_VENUE_WINDOW_S);
    } catch (err) {
      this.logger.warn(`Carga desde casa sin Redis (no se deja cargar): ${(err as Error).message}`);
      throw new ServiceUnavailableException({
        message: 'Ahora no se puede cargar saldo: inténtalo en unos minutos.',
        code: 'TRY_LATER',
      });
    }
    if (count > HOME_TOPUP_VENUE_MAX) {
      throw new HttpException(
        { message: 'Ahora hay muchas cargas a la vez en este local: prueba en unos minutos.', code: 'HOME_TOPUP_BUSY' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Cargas a medias en el local: con el pago abierto o en el banco sin
   * respuesta (las que se quedan así acaban en Incidencias). Lo caducado,
   * fallido o cancelado no cuenta.
   */
  private async assertVenueUnresolved(venueId: string): Promise<void> {
    const now = new Date();
    const open = await this.prisma.asSystem((tx) =>
      tx.payment.count({
        where: {
          tenantId: venueId,
          idempotencyKey: { startsWith: HOME_TOPUP_KEY_PREFIX },
          createdAt: { gte: new Date(now.getTime() - HOME_TOPUP_UNRESOLVED_WINDOW_MS) },
          OR: [{ status: { in: ['AUTHORIZING', 'ORPHAN'] } }, { status: 'CREATED', qrExpiresAt: { gt: now } }],
        },
      }),
    );
    if (open >= HOME_TOPUP_VENUE_MAX_UNRESOLVED) {
      throw new ConflictException({
        message: 'Ahora hay muchas cargas a medias en este local: prueba en unos minutos.',
        code: 'HOME_TOPUP_BUSY',
      });
    }
  }

  /**
   * El saldo de este local que recuerda este navegador (cookie firmada):
   * vivo, con dinero cargado (activo con saldo o a cero), no bloqueado, no
   * sumado a otro, sin «Me voy» pedido. El más reciente.
   */
  private async rememberedWallet(
    venueId: string,
    cookies: string | undefined,
  ): Promise<{ id: string; qrToken: string; shortCode: string | null } | null> {
    const ids = rememberedWalletIds(cookies, this.secret());
    if (ids.length === 0) return null;
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findMany({
        where: { id: { in: ids }, tenantId: venueId },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          qrToken: true,
          shortCode: true,
          status: true,
          balanceCents: true,
          blockedAt: true,
          mergedIntoId: true,
          closeRequestedAt: true,
          pendingAssignAt: true,
        },
      }),
    );
    const usable = rows.find(
      (w) =>
        LIVE.has(w.status) &&
        (w.status === 'DEPLETED' || w.balanceCents > 0) &&
        !w.blockedAt &&
        !w.mergedIntoId &&
        !w.closeRequestedAt &&
        !w.pendingAssignAt,
    );
    return usable ? { id: usable.id, qrToken: usable.qrToken, shortCode: usable.shortCode } : null;
  }
}
