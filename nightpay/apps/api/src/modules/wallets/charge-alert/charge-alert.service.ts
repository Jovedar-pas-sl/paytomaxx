import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { formatChargeRef } from '@nightpay/contracts';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { readWebPushConfig, type WebPushEnv, type WebPushSettings } from '../../../config/web-push';
import { clientMoney } from '../../payments/club-ui';
import { isPayLanguage, type PayLanguage } from '../../payments/customer-lang';
import { liveWalletId } from '../wallet-merge-chain';
import { CHARGE_ALERT_TEXT, fillText } from './charge-alert-text';
import { notMePath, notMeSecret, signNotMeToken } from './not-me-token';
import {
  MAX_PUSH_FAILS,
  PUSH_SENDER,
  PUSH_TIMEOUT_MS,
  PUSH_TTL_SECONDS,
  pushWithRetries,
  webPushSender,
  type PushOutcome,
  type PushSender,
} from './push-sender';
import { parsePushSubscription, pushEndpoint } from './push-subscription';

export { MAX_PUSH_FAILS, PUSH_ATTEMPTS } from './push-sender';

/** Las variables de entorno de Web Push (en las pruebas, otras). */
export const WEB_PUSH_ENV = Symbol('WEB_PUSH_ENV');

/** Navegadores apuntados por saldo como mucho (el más antiguo sale). */
export const MAX_SUBSCRIPTIONS_PER_WALLET = 5;

/** Lo que va cifrado dentro del aviso; el service worker lo enseña. */
export interface ChargePushPayload {
  title: string;
  body: string;
  /** Un aviso por cobro (si llega dos veces, se reemplaza). */
  tag: string;
  /** Tocar el aviso: la página del saldo. */
  url: string;
  /** «No he sido yo»: la página que pide confirmar (enlace firmado). */
  notMeUrl: string;
  notMeLabel: string;
}

interface ChargeRow {
  id: string;
  tenantId: string;
  walletId: string | null;
  status: string;
  amountCents: number;
  tipCents: number;
  ref: number | null;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  lang: string;
  failCount: number;
}

/**
 * «Aviso en cada cobro»: el cliente apunta su móvil desde la página del
 * saldo y, cada vez que se cobra de su saldo o de su ficha, le llega un aviso
 * (Web Push, también con la página cerrada): «Se han cobrado 12 € · En Sala
 * Aurora · te quedan 38 €», con «No he sido yo».
 *
 * El aviso sale DESPUÉS de que el cobro quede pagado (fuera de su
 * transacción) y sin esperarlo: si el servicio de avisos tarda o falla, el
 * cobro ni se bloquea ni se retrasa. Reintentos cortos; un navegador que ya
 * no existe (404/410) se borra. Sin claves VAPID, todo apagado.
 */
@Injectable()
export class ChargeAlertService {
  private readonly logger = new Logger(ChargeAlertService.name);
  private readonly settings: WebPushSettings | null;
  private readonly send: PushSender;
  private readonly env: NodeJS.ProcessEnv;
  /** En las pruebas, sin esperar de verdad. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(PUSH_SENDER) sender?: PushSender,
    @Optional() @Inject(WEB_PUSH_ENV) env?: WebPushEnv & NodeJS.ProcessEnv,
  ) {
    this.env = env ?? process.env;
    const config = readWebPushConfig(this.env);
    this.settings = config.status === 'on' ? config.settings : null;
    this.send = sender ?? webPushSender;
  }

  /** La clave pública para la página (null: apagado, la página no ofrece el aviso). */
  get publicKey(): string | null {
    return this.settings?.publicKey ?? null;
  }

  get enabled(): boolean {
    return this.settings !== null;
  }

  /** Apunta este navegador al saldo (o lo pone al día). 400 si la suscripción no vale. */
  async subscribe(walletId: string, body: unknown, lang: PayLanguage): Promise<{ ok: true }> {
    if (!this.settings) throw new BadRequestException({ message: 'Los avisos no están activados.', code: 'PUSH_OFF' });
    const sub = parsePushSubscription(body);
    if (!sub) throw new BadRequestException({ message: 'No se ha podido activar el aviso en este navegador.', code: 'PUSH_INVALID' });
    await this.prisma.acrossVenues(async (tx) => {
      const wallet = await tx.clientWallet.findUnique({ where: { id: walletId }, select: { tenantId: true } });
      if (!wallet) throw new BadRequestException({ message: 'Saldo no encontrado', code: 'WALLET_NOT_FOUND' });
      await tx.walletPushSubscription.upsert({
        where: { walletId_endpoint: { walletId, endpoint: sub.endpoint } },
        create: { tenantId: wallet.tenantId, walletId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, lang },
        update: { p256dh: sub.p256dh, auth: sub.auth, lang, failCount: 0 },
      });
      // Como mucho unos pocos por saldo: el más antiguo sale.
      const extra = await tx.walletPushSubscription.findMany({
        where: { walletId },
        orderBy: { updatedAt: 'desc' },
        skip: MAX_SUBSCRIPTIONS_PER_WALLET,
        select: { id: true },
      });
      if (extra.length > 0) await tx.walletPushSubscription.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
    });
    return { ok: true };
  }

  /** ¿Este navegador está apuntado a este saldo? (la fila de la página dice «Activado»). */
  async isSubscribed(walletId: string, body: unknown): Promise<boolean> {
    const endpoint = pushEndpoint((body as { endpoint?: unknown } | null)?.endpoint);
    if (!endpoint || !this.settings) return false;
    const n = await this.prisma.acrossVenues((tx) => tx.walletPushSubscription.count({ where: { walletId, endpoint } }));
    return n > 0;
  }

  /** Quita este navegador del saldo («Avisarme de cada cobro» apagado). */
  async unsubscribe(walletId: string, body: unknown): Promise<{ ok: true }> {
    const endpoint = pushEndpoint((body as { endpoint?: unknown } | null)?.endpoint);
    if (!endpoint) return { ok: true };
    await this.prisma.acrossVenues((tx) => tx.walletPushSubscription.deleteMany({ where: { walletId, endpoint } }));
    return { ok: true };
  }

  /**
   * El cobro del saldo `chargeId` acaba de quedar pagado: avisar a sus
   * móviles. No espera ni lanza: el cobro ya está hecho y no depende de esto.
   */
  chargePaid(chargeId: string): void {
    if (!this.settings) return;
    void this.notifyCharge(chargeId).catch((err: unknown) => {
      this.logger.warn(`Aviso del cobro ${chargeId}: no se ha podido mandar (${(err as Error)?.message ?? err})`);
    });
  }

  /** Manda el aviso del cobro a cada móvil apuntado al saldo. Cuántos lo recibieron. */
  async notifyCharge(chargeId: string): Promise<number> {
    const vapid = this.settings;
    if (!vapid) return 0;
    const found = await this.prisma.acrossVenues(async (tx) => {
      const charge = await tx.walletChargeRequest.findUnique({
        where: { id: chargeId },
        select: { id: true, tenantId: true, walletId: true, status: true, amountCents: true, tipCents: true, ref: true },
      });
      if (!charge?.walletId || charge.status !== 'ACCEPTED') return null;
      const liveId = (await liveWalletId(tx, charge.walletId)) ?? charge.walletId;
      const walletIds = [...new Set([charge.walletId, liveId])];
      const [venue, wallet, subs] = await Promise.all([
        tx.venue.findUnique({ where: { id: charge.tenantId }, select: { name: true } }),
        tx.clientWallet.findUnique({ where: { id: liveId }, select: { balanceCents: true, qrToken: true } }),
        tx.walletPushSubscription.findMany({
          where: { walletId: { in: walletIds } },
          select: { id: true, endpoint: true, p256dh: true, auth: true, lang: true, failCount: true },
        }),
      ]);
      return { charge: charge as ChargeRow, venueName: venue?.name ?? null, wallet, subs };
    });
    if (!found || !found.wallet || found.subs.length === 0) return 0;
    const token = signNotMeToken({ chargeId: found.charge.id, walletId: found.charge.walletId! }, Date.now(), notMeSecret(this.env));
    // Un navegador apuntado a dos saldos de la cadena: un solo aviso.
    const seen = new Set<string>();
    const unique = found.subs.filter((s) => !seen.has(s.endpoint) && Boolean(seen.add(s.endpoint)));
    const outcomes = await Promise.all(
      unique.map((sub) => {
        const payload = chargePushPayload({
          lang: isPayLanguage(sub.lang) ? sub.lang : 'es',
          chargeId: found.charge.id,
          totalCents: found.charge.amountCents + (found.charge.tipCents ?? 0),
          balanceCents: found.wallet!.balanceCents,
          venueName: found.venueName,
          walletPath: `/w/${encodeURIComponent(found.wallet!.qrToken)}`,
          notMePath: notMePath(token),
        });
        return this.deliver(sub, JSON.stringify(payload), vapid);
      }),
    );
    return outcomes.filter((o) => o === 'sent').length;
  }

  /** Un navegador: hasta PUSH_ATTEMPTS intentos; 404/410 lo borra; muchos fallos seguidos, también. */
  private async deliver(sub: SubscriptionRow, payload: string, vapid: WebPushSettings): Promise<PushOutcome> {
    const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    const options = { vapid, ttlSeconds: PUSH_TTL_SECONDS, timeoutMs: PUSH_TIMEOUT_MS };
    const outcome = await pushWithRetries(this.send, target, payload, options, this.sleep);
    await this.record(sub, outcome).catch((err: unknown) => {
      this.logger.warn(`Aviso de cobro: no se ha podido apuntar el resultado (${(err as Error)?.message ?? err})`);
    });
    return outcome;
  }

  private async record(sub: SubscriptionRow, outcome: PushOutcome): Promise<void> {
    await this.prisma.acrossVenues(async (tx) => {
      if (outcome === 'sent') {
        await tx.walletPushSubscription.updateMany({ where: { id: sub.id }, data: { failCount: 0, lastSentAt: new Date() } });
        return;
      }
      // Ya no existe (el cliente quitó el permiso o borró el navegador): fuera, en todos sus saldos.
      if (outcome === 'gone' || sub.failCount + 1 >= MAX_PUSH_FAILS) {
        await tx.walletPushSubscription.deleteMany({ where: outcome === 'gone' ? { endpoint: sub.endpoint } : { id: sub.id } });
        return;
      }
      await tx.walletPushSubscription.updateMany({ where: { id: sub.id }, data: { failCount: { increment: 1 } } });
    });
  }
}

/** El aviso de un cobro, en la lengua del navegador. Solo el nombre del local: nada del personal. */
export function chargePushPayload(input: {
  lang: PayLanguage;
  chargeId: string;
  totalCents: number;
  balanceCents: number;
  venueName: string | null;
  walletPath: string;
  notMePath: string;
}): ChargePushPayload {
  const t = CHARGE_ALERT_TEXT[input.lang];
  const balance = clientMoney(input.balanceCents, t.locale);
  const venue = input.venueName?.trim();
  return {
    title: fillText(t.pushTitle, { amount: clientMoney(input.totalCents, t.locale) }),
    body: venue ? fillText(t.pushBody, { venue, balance }) : fillText(t.pushBodyNoVenue, { balance }),
    tag: `cobro-${input.chargeId}`,
    url: input.walletPath,
    notMeUrl: input.notMePath,
    notMeLabel: t.pushNotMe,
  };
}

/** «C-0042» del cobro (o null si es de antes de las referencias). */
export function chargeRefText(ref: number | null): string | null {
  return formatChargeRef(ref);
}
