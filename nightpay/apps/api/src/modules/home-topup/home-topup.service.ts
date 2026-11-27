import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import type { Redis } from 'ioredis';
import {
  methodsNeededForPayment,
  nightSettingsOf,
  paymentMethodsOf,
  serviceFeeBpsFor,
  type CreatePaymentDto,
  type HomeTopUpProblem,
  type VenueServiceFee,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { isPartyEdition } from '../../config/edition';
import { PaymentsService } from '../payments/payments.service';
import type { PayLanguage } from '../payments/customer-lang';
import { VENUE_SERVICE_FEE_SELECT, venueServiceFeeOf } from '../payments/service-fee';
import { VENUE_METHODS_SELECT, assertMethodsEnabled } from '../venues/venue-methods';
import { VENUE_PAUSE_SELECT, assertVenueNotPaused, venuePauseScope, type VenuePauseState } from '../venues/venue-pause';
import type { VenueServiceFeeRow } from '../payments/service-fee';
import { codeHintOf } from '../wallets/wallet-charges.service';
import { eur } from '../../common/money/eur';
import {
  SELF_TOPUP_MAX_CENTS,
  SELF_TOPUP_MIN_CENTS,
  selfTopUpPresets,
  isClientTopUpKey,
  parseTopUpAmount,
  topUpFeeTable,
  type TopUpVenueState,
} from '../wallets/wallet-topup-rules';
import { rateLimitIpKey } from '../../common/http/client-ip';
import { BASE_GATEWAY_WHERE } from '../gateways/card-gateway';
import {
  HOME_TOPUP_DAY_S,
  HOME_TOPUP_IP_DAY_MAX,
  HOME_TOPUP_IP_VENUE_DAY_MAX,
  HOME_TOPUP_KEY_PREFIX,
  HOME_TOPUP_UNRESOLVED_WINDOW_MS,
  HOME_TOPUP_VENUE_MAX,
  HOME_TOPUP_VENUE_MAX_UNRESOLVED,
  HOME_TOPUP_VENUE_WINDOW_S,
  QUEUE_KEY_PREFIX,
  homeTopUpKey,
  homeTopUpProblem,
  ipDayKeys,
  isHomeTopUpCode,
  queueThrottleKey,
  rememberValid,
  rememberedEntries,
  venueThrottleKey,
} from './home-topup-rules';
import {
  QUEUE_COOKIES_PER_IP_MAX,
  QUEUE_DEVICE_MAX,
  QUEUE_IP_NIGHT_MAX,
  QUEUE_NIGHT_MAX,
  QUEUE_OPEN_TTL_S,
  QUEUE_PENDING_TTL_S,
  newQueueDevice,
  queueCookieKey,
  queueDeviceCookie,
  queueDeviceId,
  queueIpKey,
  queueKeys,
  queueOpenKey,
  queueTokenValid,
} from './home-topup-queue';
import { GIFT_MESSAGE_MAX, GIFT_NAME_MAX, giftExpiresAt, newGiftToken, parseGiftTexts } from './home-topup-gift';

/** El local de un enlace encendido, con lo que hace falta para cargar. */
export interface HomeVenue {
  id: string;
  name: string;
  state: TopUpVenueState;
  raw: VenuePauseState & { paymentMethods: unknown };
  terminalExternalId: string | null;
  serviceFee: VenueServiceFee;
  /** Los importes que se ofrecen: los de su recepción (Ajustes → Noche, A9). */
  presetsCents: number[];
  /** «Regala una noche»: «Para regalar» encendido (apagado de serie). */
  gifts: boolean;
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
  /**
   * El local da fichas (NFC): al llegar, su QR en recepción (wallet-welcome).
   * Sin el dato, sí: lo que decía la página hasta ahora.
   */
  fichas?: boolean;
  /**
   * Abierta con el QR del cartel de la cola (B16): `token`, el de esta noche
   * (la carga va por /r/:code/cola); `expired`, uno de otra noche (la página
   * lo dice y carga como el enlace de siempre). Sin cartel, no va. `noDevice`:
   * esta IP ya ha sacado muchos móviles nuevos esta noche; no hay cookie, la
   * página lo dice y carga como el enlace de siempre (con su tope por IP).
   */
  queue?: { token: string; noDevice?: true } | { expired: true };
  /** «Regala una noche» encendido: la página ofrece «Para regalar». */
  gifts?: boolean;
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
/** Las claves del tope de 24 h de una IP (en este local y en todos). */
type IpDayKeys = ReturnType<typeof ipDayKeys>;

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
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
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
          homeTopUpGiftsEnabled: true,
          deletedAt: true,
          nightSettings: true,
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
        select: { id: true, name: true, nightSettings: true, ...VENUE_PAUSE_SELECT, ...VENUE_METHODS_SELECT, ...VENUE_SERVICE_FEE_SELECT },
      });
      return venue ? this.withState(tx, venue) : null;
    });
  }

  /** La página: importes, comisión y, si este navegador ya tiene un saldo de aquí, ese. null = 404. */
  async page(code: string, cookies: string | undefined, queueToken?: string): Promise<HomeTopUpPageView | null> {
    const venue = await this.venueByCode(code);
    if (!venue) return null;
    const mine = await this.rememberedWallet(venue.id, cookies);
    const queue =
      queueToken === undefined
        ? null
        : queueTokenValid(this.secret(), venue.id, code, queueToken)
          ? { token: queueToken }
          : { expired: true as const };
    return {
      ...(queue ? { queue } : {}),
      venueName: venue.name,
      problem: homeTopUpProblem(venue.state),
      presetsCents: venue.presetsCents,
      minCents: SELF_TOPUP_MIN_CENTS,
      maxCents: SELF_TOPUP_MAX_CENTS,
      serviceFeeBps: serviceFeeBpsFor(venue.serviceFee, 'topUp'),
      feesCents: topUpFeeTable(venue.serviceFee, SELF_TOPUP_MIN_CENTS, SELF_TOPUP_MAX_CENTS),
      mine: mine ? { codeHint: codeHintOf(mine.shortCode) } : null,
      fichas: paymentMethodsOf(venue.raw.paymentMethods).nfc,
      ...(venue.gifts ? { gifts: true } : {}),
    };
  }

  /** «Recargar mi saldo»: la página del saldo que recuerda este navegador, en «Recargar» (null: no tiene). */
  async mySaldoHref(code: string, cookies: string | undefined, lang: PayLanguage): Promise<string | null> {
    const venue = await this.venueByCode(code);
    if (!venue) return null;
    const mine = await this.rememberedWallet(venue.id, cookies);
    return mine ? `/w/${encodeURIComponent(mine.qrToken)}?lang=${lang}#recargar` : null;
  }

  /** Crea la carga (un saldo nuevo de este local) y dice a dónde ir a pagarla. `ip`: la del cliente (clientIp), para el tope de 24 h. */
  async start(
    code: string,
    input: {
      amountCents: unknown;
      key: unknown;
      lang: PayLanguage;
      ip: string | null;
      /** Desde el cartel de la cola (B16): su QR de la noche y el móvil (cookie firmada). */
      queue?: { token: unknown; deviceId: string | null };
      /** «Para regalar»: el nombre y el mensaje (opcionales). Quien paga no se lleva el saldo. */
      gift?: { name: unknown; message: unknown };
    },
  ): Promise<HomeTopUpStarted> {
    const venue = await this.venueByCode(code);
    // Con «Regalos» apagado, como un enlace apagado: 404 sin pistas.
    if (!venue || (input.gift && !venue.gifts)) throw homeTopUpGone();
    const giftTexts = input.gift ? parseGiftTexts(input.gift.name, input.gift.message) : null;
    if (input.gift && !giftTexts) {
      throw new BadRequestException({
        message: `El nombre va hasta ${GIFT_NAME_MAX} letras y el mensaje hasta ${GIFT_MESSAGE_MAX}.`,
        code: 'GIFT_TEXT',
      });
    }
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
    // Desde el cartel: el QR de esta noche y el móvil, o nada.
    if (input.queue) this.assertQueue(venue.id, code, input.queue);
    const fromQueue = input.gift ? null : (input.queue?.deviceId ?? null);
    const key = homeTopUpKey(this.secret(), venue.id, input.key, giftTexts ? 'gift' : fromQueue !== null ? 'queue' : 'link');
    // La misma clave repetida (doble toque, la red): el mismo cobro, sin gastar otra vez el freno.
    const replay = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId: venue.id, idempotencyKey: key } }, select: { id: true } }),
    );
    // Los huecos que se cogen: si la carga no llega a empezar, se devuelven.
    let day: IpDayKeys | null = null;
    const counted: string[] = [];
    let slot: string | null = null;
    try {
      if (!replay && fromQueue === null) {
        // Del enlace de siempre: el tope de 24 h de esta IP.
        day = await this.takeIpDay(venue.id, input.ip);
      } else if (!replay && fromQueue !== null) {
        // Desde el cartel (toda la cola sale por el wifi del local): su IP esta noche
        // (holgado), su móvil, la noche y como mucho una carga sin pagar por móvil.
        const ipKey = await this.takeQueueIp(venue.id, input.ip);
        if (ipKey) counted.push(ipKey);
        const queued = await this.takeQueue(venue.id, fromQueue);
        counted.push(queued.device, queued.night);
        slot = await this.holdQueueSlot(venue.id, fromQueue);
      }
      if (!replay) {
        await this.throttleVenue(venue.id, fromQueue !== null);
        await this.assertVenueUnresolved(venue.id, fromQueue !== null);
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
      if (giftTexts) await this.saveGift(venue.id, created, giftTexts);
      this.logger.log(
        `Carga desde casa${giftTexts ? ' (regalo)' : ''}: venue=${venue.id} payment=${created.id} wallet=${created.walletId ?? '-'} amount=${amountCents}c`,
      );
      // Cada carga desde el cartel, en el registro (el móvil, recortado: no es nada personal).
      if (slot && fromQueue !== null) {
        await this.keepQueueSlot(slot, created.id);
        await this.audit?.log({
          action: 'home_topup.queue',
          tenantId: venue.id,
          targetType: 'Payment',
          targetId: created.id,
          payload: { amountCents, walletId: created.walletId ?? null, device: fromQueue.slice(0, 8) },
        });
      }
      return { payToken: created.qrToken, payUrl: `/pay/${encodeURIComponent(created.qrToken)}?lang=${input.lang}` };
    } catch (err) {
      if (day) await this.giveBackIpDay(day);
      if (counted.length > 0) await this.giveBack(counted);
      if (slot) await this.releaseQueueSlot(slot);
      throw err;
    }
  }

  /**
   * El regalo de esta carga, con su enlace (al azar, no el del saldo), y su
   * saldo sin grupo (solo este local). La misma carga repetida (doble toque)
   * no crea otro: se queda el primero.
   */
  private async saveGift(
    venueId: string,
    payment: { id: string; walletId?: string | null },
    texts: { toName: string | null; message: string | null },
  ): Promise<void> {
    const walletId = payment.walletId;
    if (!walletId) throw new ConflictException({ message: 'Esta carga ya no vale: vuelve a pulsar el botón.', code: 'WALLET_TOPUP_STALE' });
    const now = new Date();
    await this.prisma.asSystem(async (tx) => {
      // El regalo vale solo en este local: el saldo nuevo, sin el grupo de locales.
      await tx.clientWallet.updateMany({ where: { id: walletId, tenantId: venueId }, data: { walletGroup: null } });
      await tx.walletGift.createMany({
        data: [{ tenantId: venueId, walletId, paymentId: payment.id, token: newGiftToken(), ...texts, expiresAt: giftExpiresAt(now), createdAt: now }],
        skipDuplicates: true,
      });
    });
  }

  // ─── El cartel de la cola (B16) ───────────────────────────────────

  /** El móvil de la cookie del cartel (firmada); null si no la tiene o no vale. */
  queueDevice(cookies: string | undefined): string | null {
    return queueDeviceId(this.secret(), cookies);
  }

  /**
   * La cookie del móvil para la página del cartel, si aún no la tiene
   * (`cookie` null: ya la tiene). Como mucho QUEUE_COOKIES_PER_IP_MAX móviles
   * nuevos por IP y noche: pasado eso (o sin Redis), `refused` y ninguna
   * cookie; la página lo dice y carga como el enlace de siempre.
   */
  async queueDeviceSetCookie(code: string, cookies: string | undefined, ip: string | null): Promise<{ cookie: string | null; refused: boolean }> {
    if (this.queueDevice(cookies) || this.secret().length < 32) return { cookie: null, refused: false };
    if (ip) {
      const key = queueCookieKey(code, rateLimitIpKey(ip));
      const given = await this.count(key, HOME_TOPUP_DAY_S).catch(() => null);
      if (given === null || given > QUEUE_COOKIES_PER_IP_MAX) {
        this.logger.warn(`Cartel de la cola: sin cookie nueva para la IP ${ip} (${given ?? 'sin Redis'}/${QUEUE_COOKIES_PER_IP_MAX} esta noche)`);
        return { cookie: null, refused: true };
      }
    }
    const secure = !['development', 'test'].includes(process.env.NODE_ENV ?? '');
    return { cookie: queueDeviceCookie(newQueueDevice(this.secret()), secure), refused: false };
  }

  /** El QR de esta noche y el móvil (cookie firmada): si no, no se carga desde el cartel. */
  private assertQueue(venueId: string, code: string, queue: { token: unknown; deviceId: string | null }): void {
    if (!queueTokenValid(this.secret(), venueId, code, queue.token)) {
      throw new BadRequestException({ message: 'Este QR era de otra noche: escanea el del cartel de hoy.', code: 'HOME_TOPUP_QUEUE_EXPIRED' });
    }
    if (!queue.deviceId) {
      throw new BadRequestException({
        message: 'Tu navegador no guarda la sesión de esta página: ábrela otra vez desde el QR o carga en recepción.',
        code: 'HOME_TOPUP_QUEUE_COOKIE',
      });
    }
  }

  /** Un hueco de los topes del cartel: por móvil y por local esta noche (si se pasa, se devuelve). */
  private async takeQueue(venueId: string, deviceId: string): Promise<{ device: string; night: string }> {
    const keys = queueKeys(venueId, deviceId);
    const device = await this.count(keys.device, HOME_TOPUP_DAY_S);
    const night = await this.count(keys.night, HOME_TOPUP_DAY_S);
    if (device > QUEUE_DEVICE_MAX || night > QUEUE_NIGHT_MAX) {
      await this.giveBack([keys.device, keys.night]);
      const tooMany = device > QUEUE_DEVICE_MAX;
      this.logger.warn(`Carga desde el cartel parada (venue=${venueId}): ${tooMany ? `móvil ${device}/${QUEUE_DEVICE_MAX}` : `noche ${night}/${QUEUE_NIGHT_MAX}`}`);
      throw new HttpException(
        tooMany
          ? { message: 'Ya has cargado varias veces desde este móvil esta noche: pídelo en recepción.', code: 'HOME_TOPUP_QUEUE_DEVICE' }
          : { message: 'Esta noche ya no se puede cargar desde el cartel: pídelo en recepción.', code: 'HOME_TOPUP_QUEUE_NIGHT' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return keys;
  }

  /** Cargas desde el cartel por IP y noche (holgado: la cola sale por el wifi). Sin IP de fiar no se cuenta. */
  private async takeQueueIp(venueId: string, ip: string | null): Promise<string | null> {
    if (!ip) return null;
    const key = queueIpKey(venueId, rateLimitIpKey(ip));
    const count = await this.count(key, HOME_TOPUP_DAY_S);
    if (count > QUEUE_IP_NIGHT_MAX) {
      await this.giveBack([key]);
      this.logger.warn(`Carga desde el cartel parada (venue=${venueId}): IP ${ip} ${count}/${QUEUE_IP_NIGHT_MAX} esta noche`);
      throw new HttpException(
        { message: 'Desde esta conexión ya se ha cargado mucho desde el cartel esta noche: usa los datos del móvil o pídelo en recepción.', code: 'HOME_TOPUP_QUEUE_IP' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return key;
  }

  /**
   * Como mucho una carga sin pagar a la vez por móvil: la de antes, pagada,
   * caducada o fallida, ya no cuenta. Coge el hueco («pending» mientras se
   * crea, para dos toques a la vez) y devuelve su clave. Sin Redis, no (503).
   */
  private async holdQueueSlot(venueId: string, deviceId: string): Promise<string> {
    const key = queueOpenKey(venueId, deviceId);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if ((await this.redis.set(key, 'pending', 'EX', QUEUE_PENDING_TTL_S, 'NX')) === 'OK') return key;
        const held = await this.redis.get(key);
        if (held && held !== 'pending' && !(await this.queueLoadOpen(venueId, held))) {
          await this.redis.del(key);
          continue;
        }
        break;
      }
    } catch (err) {
      this.logger.warn(`Carga desde el cartel sin Redis (no se deja cargar): ${(err as Error).message}`);
      throw new ServiceUnavailableException({ message: 'Ahora no se puede cargar saldo: inténtalo en unos minutos.', code: 'TRY_LATER' });
    }
    throw new ConflictException({
      message: 'Ya tienes una carga sin pagar en este móvil: págala o espera unos minutos a que caduque.',
      code: 'HOME_TOPUP_QUEUE_OPEN',
    });
  }

  /** ¿Sigue sin pagar? (el pago abierto o en el banco) */
  private async queueLoadOpen(venueId: string, paymentId: string): Promise<boolean> {
    const now = new Date();
    const open = await this.prisma.asSystem((tx) =>
      tx.payment.count({
        where: { id: paymentId, tenantId: venueId, OR: [{ status: 'AUTHORIZING' }, { status: 'CREATED', qrExpiresAt: { gt: now } }] },
      }),
    );
    return open > 0;
  }

  /** La carga ya creada queda como la sin pagar de este móvil (hasta que se pague o caduque). */
  private async keepQueueSlot(key: string, paymentId: string): Promise<void> {
    try {
      await this.redis.set(key, paymentId, 'EX', QUEUE_OPEN_TTL_S);
    } catch (err) {
      this.logger.warn(`Carga desde el cartel: no se pudo apuntar la carga sin pagar del móvil: ${(err as Error).message}`);
    }
  }

  /** Suelta el hueco de una carga que no llegó a crearse. */
  private async releaseQueueSlot(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(`Carga desde el cartel: no se pudo soltar el hueco del móvil: ${(err as Error).message}`);
    }
  }

  /** Devuelve los huecos de una carga que no llegó a empezar (si Redis falla aquí, quedan contados). */
  private async giveBack(keys: string[]): Promise<void> {
    try {
      for (const key of keys) await this.redis.decr(key);
    } catch (err) {
      this.logger.warn(`Carga desde el cartel: no se pudo devolver el hueco: ${(err as Error).message}`);
    }
  }

  // ─── Auxiliares ────────────────────────────────────────────────────

  private secret(): string {
    return this.config.get<string>('COOKIE_SECRET') ?? '';
  }

  /** Pausa, formas de cobro, pasarela y el terminal al que se apunta la carga. */
  private async withState(
    tx: TransactionalClient,
    venue: { id: string; name: string; paymentMethods: unknown; nightSettings?: unknown; homeTopUpGiftsEnabled?: boolean } & VenuePauseState &
      Partial<VenueServiceFeeRow>,
  ): Promise<HomeVenue> {
    const gateways = await tx.gatewayCredential.count({ where: { tenantId: venue.id, ...BASE_GATEWAY_WHERE } });
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
      presetsCents: selfTopUpPresets(nightSettingsOf(venue.nightSettings).receptionQuickAmountsCents),
      // En OxioParty no hay regalos: «Lo que sobra» devolvería lo que sobre a la tarjeta de quien regaló.
      gifts: venue.homeTopUpGiftsEnabled === true && !isPartyEdition(),
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

  /**
   * El tope de 24 h por IP (home-topup-rules): HOME_TOPUP_IP_VENUE_DAY_MAX
   * cargas nuevas en este local y HOME_TOPUP_IP_DAY_MAX en todos. Coge un
   * hueco y devuelve sus claves; si se pasa, lo devuelve y dice que no. Sin IP
   * de fiar no se cuenta (como el freno de las IP); sin Redis no se carga (503).
   */
  private async takeIpDay(venueId: string, ip: string | null): Promise<IpDayKeys | null> {
    if (!ip) return null;
    const keys = ipDayKeys(rateLimitIpKey(ip), venueId);
    const inVenue = await this.count(keys.venue, HOME_TOPUP_DAY_S);
    const inAll = await this.count(keys.all, HOME_TOPUP_DAY_S);
    if (inVenue > HOME_TOPUP_IP_VENUE_DAY_MAX || inAll > HOME_TOPUP_IP_DAY_MAX) {
      await this.giveBackIpDay(keys);
      this.logger.warn(`Carga desde casa: tope de 24 h de la IP ${ip} (local ${inVenue}/${HOME_TOPUP_IP_VENUE_DAY_MAX}, todos ${inAll}/${HOME_TOPUP_IP_DAY_MAX})`);
      throw new HttpException(
        {
          message: 'Has hecho muchas cargas hoy desde esta conexión. Prueba con los datos del móvil o pide tu saldo en recepción.',
          code: 'HOME_TOPUP_DAILY',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return keys;
  }

  /**
   * Devuelve el hueco del día de una carga que no llegó a empezar (parada por
   * el tope, el freno del local, las que hay en curso o un fallo al crearla):
   * solo cuentan las que empiezan. Si Redis falla aquí, se queda contada.
   */
  private async giveBackIpDay(keys: IpDayKeys): Promise<void> {
    try {
      await this.redis.decr(keys.venue);
      await this.redis.decr(keys.all);
    } catch (err) {
      this.logger.warn(`Carga desde casa: no se pudo devolver el hueco del día de la IP: ${(err as Error).message}`);
    }
  }

  /**
   * Como mucho HOME_TOPUP_VENUE_MAX cargas empezadas cada 15 min en el local;
   * las del cartel, en su propia cuenta (no paran el enlace). Sin Redis, no (503).
   */
  private async throttleVenue(venueId: string, fromQueue: boolean): Promise<void> {
    const count = await this.count(fromQueue ? queueThrottleKey(venueId) : venueThrottleKey(venueId), HOME_TOPUP_VENUE_WINDOW_S);
    if (count > HOME_TOPUP_VENUE_MAX) {
      throw new HttpException(
        { message: 'Ahora hay muchas cargas a la vez en este local: prueba en unos minutos.', code: 'HOME_TOPUP_BUSY' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Suma una carga al contador (con caducidad en la primera). Sin Redis no se carga: 503 (fail-closed, como «Recargar»). */
  private async count(key: string, ttlS: number): Promise<number> {
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, ttlS);
      return count;
    } catch (err) {
      this.logger.warn(`Carga desde casa sin Redis (no se deja cargar): ${(err as Error).message}`);
      throw new ServiceUnavailableException({
        message: 'Ahora no se puede cargar saldo: inténtalo en unos minutos.',
        code: 'TRY_LATER',
      });
    }
  }

  /**
   * Cargas en curso en el local, de la última hora: con el pago abierto o en
   * el banco. Lo caducado, fallido, cancelado o ya sin respuesta del banco
   * (ORPHAN, en Incidencias) no cuenta: si no, unas pocas abandonadas a
   * propósito dejarían el enlace parado. Solo las del enlace (sin persona).
   * Las del cartel de la cola (`wcasa:cola:`) se cuentan aparte: las de la
   * cola no paran el enlace de siempre, ni al revés.
   */
  private async assertVenueUnresolved(venueId: string, fromQueue: boolean): Promise<void> {
    const now = new Date();
    const open = await this.prisma.asSystem((tx) =>
      tx.payment.count({
        where: {
          tenantId: venueId,
          createdByUserId: null,
          idempotencyKey: { startsWith: fromQueue ? QUEUE_KEY_PREFIX : HOME_TOPUP_KEY_PREFIX },
          ...(fromQueue ? {} : { NOT: { idempotencyKey: { startsWith: QUEUE_KEY_PREFIX } } }),
          createdAt: { gte: new Date(now.getTime() - HOME_TOPUP_UNRESOLVED_WINDOW_MS) },
          OR: [{ status: 'AUTHORIZING' }, { status: 'CREATED', qrExpiresAt: { gt: now } }],
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
   * El saldo de este local que recuerda este navegador (cookie firmada con
   * su enlace de ahora: tras un enlace nuevo del dueño, ya no vale): vivo,
   * con dinero cargado (activo con saldo o a cero), no bloqueado, no sumado
   * a otro, sin «Me voy» pedido. El más reciente.
   */
  private async rememberedWallet(
    venueId: string,
    cookies: string | undefined,
  ): Promise<{ id: string; qrToken: string; shortCode: string | null } | null> {
    const secret = this.secret();
    const entries = rememberedEntries(cookies);
    if (!secret || entries.length === 0) return null;
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findMany({
        where: { id: { in: entries.map((e) => e.walletId) }, tenantId: venueId },
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
    const signed = (w: { id: string; qrToken: string }): boolean =>
      entries.some((e) => e.walletId === w.id && rememberValid(secret, e, w.qrToken));
    const usable = rows.find(
      (w) =>
        signed(w) &&
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
