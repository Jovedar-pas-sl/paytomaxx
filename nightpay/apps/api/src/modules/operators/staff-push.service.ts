import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { formatMoney } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { readWebPushConfig, type WebPushEnv, type WebPushSettings } from '../../config/web-push';
import { WEB_PUSH_ENV } from '../wallets/charge-alert/charge-alert.service';
import {
  MAX_PUSH_FAILS,
  PUSH_SENDER,
  PUSH_TIMEOUT_MS,
  PUSH_TTL_SECONDS,
  pushWithRetries,
  webPushSender,
  type PushOutcome,
  type PushSender,
} from '../wallets/charge-alert/push-sender';
import { parsePushSubscription, pushEndpoint } from '../wallets/charge-alert/push-subscription';

/** Navegadores por persona como mucho (el más antiguo sale). */
export const MAX_SUBSCRIPTIONS_PER_USER = 5;

/** Lo que va cifrado dentro del aviso; el service worker de la app lo enseña. */
export interface StaffPushPayload {
  title: string;
  body: string;
  /** Un aviso por pago (si llega dos veces, se reemplaza). */
  tag: string;
  /** Tocar el aviso: «Ganancias» de la app. */
  url: string;
}

export interface PayoutMade {
  tenantId: string;
  operatorId: string;
  payoutId: string;
  totalCents: number;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failCount: number;
}

/** El aviso de un pago: el importe y nada más (sale en la pantalla bloqueada: ni el local ni la cuenta). */
export function payoutPushPayload(payoutId: string, totalCents: number): StaffPushPayload {
  return {
    title: `Te han pagado ${formatMoney(totalCents, { compact: true })}`,
    body: 'Míralo en Ganancias.',
    tag: `pago-${payoutId}`,
    url: '/?t=ganancias',
  };
}

/**
 * «Te han pagado»: la compañera apunta su móvil desde «Mi perfil» y, cuando
 * el local le apunta un pago, le llega un aviso (Web Push, también con la
 * app cerrada). Las mismas claves VAPID que el «Aviso en cada cobro» del
 * cliente; sin ellas, todo apagado. El aviso sale DESPUÉS de apuntar el pago y
 * sin esperarlo: si el servicio de avisos tarda o falla, el pago ni se bloquea
 * ni se retrasa. Un navegador que ya no existe (404/410) se borra.
 */
@Injectable()
export class StaffPushService {
  private readonly logger = new Logger(StaffPushService.name);
  private readonly settings: WebPushSettings | null;
  private readonly send: PushSender;
  /** En las pruebas, sin esperar de verdad. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(PUSH_SENDER) sender?: PushSender,
    @Optional() @Inject(WEB_PUSH_ENV) env?: WebPushEnv,
  ) {
    const config = readWebPushConfig(env ?? process.env);
    this.settings = config.status === 'on' ? config.settings : null;
    this.send = sender ?? webPushSender;
  }

  /** La clave pública para la app (null: apagado, la app no ofrece el aviso). */
  get publicKey(): string | null {
    return this.settings?.publicKey ?? null;
  }

  /** Apunta este navegador a esta persona (o lo pone al día). 400 si la suscripción no vale. */
  async subscribe(userId: string, tenantId: string, body: unknown): Promise<{ ok: true }> {
    if (!this.settings) throw new BadRequestException({ message: 'Los avisos no están activados.', code: 'PUSH_OFF' });
    const sub = parsePushSubscription(body);
    if (!sub) throw new BadRequestException({ message: 'No se ha podido activar el aviso en este móvil.', code: 'PUSH_INVALID' });
    // Fuera de un local (bypass): un navegador avisa a una sola persona y, si
    // era de otra (otra sesión en este móvil, aunque sea de otro local), pasa a esta.
    await this.prisma.acrossVenues(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO staff_push_subscriptions ("tenantId", "userId", endpoint, p256dh, auth)
        VALUES (${tenantId}::uuid, ${userId}::uuid, ${sub.endpoint}, ${sub.p256dh}, ${sub.auth})
        ON CONFLICT (endpoint) DO UPDATE
          SET "tenantId" = EXCLUDED."tenantId", "userId" = EXCLUDED."userId", p256dh = EXCLUDED.p256dh,
              auth = EXCLUDED.auth, "failCount" = 0, "updatedAt" = now()`;
      const extra = await tx.staffPushSubscription.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        skip: MAX_SUBSCRIPTIONS_PER_USER,
        select: { id: true },
      });
      if (extra.length > 0) await tx.staffPushSubscription.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
    });
    return { ok: true };
  }

  /** Quita este navegador («Quitar el aviso»). */
  async unsubscribe(userId: string, body: unknown): Promise<{ ok: true }> {
    const endpoint = pushEndpoint((body as { endpoint?: unknown } | null)?.endpoint);
    if (!endpoint) return { ok: true };
    await this.prisma.acrossVenues((tx) => tx.staffPushSubscription.deleteMany({ where: { userId, endpoint } }));
    return { ok: true };
  }

  /** Le acaban de apuntar un pago: avisar a sus móviles. No espera ni lanza (el pago ya está hecho). */
  payoutMade(paid: PayoutMade): void {
    if (!this.settings) return;
    void this.notifyPayout(paid).catch((err: unknown) => {
      this.logger.warn(`Aviso del pago ${paid.payoutId}: no se ha podido mandar (${(err as Error)?.message ?? err})`);
    });
  }

  /** Manda el aviso del pago a cada móvil apuntado de esa persona. Cuántos lo recibieron. */
  async notifyPayout(paid: PayoutMade): Promise<number> {
    const vapid = this.settings;
    if (!vapid) return 0;
    const subs: SubscriptionRow[] = await this.prisma.withTenant(paid.tenantId, (tx) =>
      tx.staffPushSubscription.findMany({
        where: { userId: paid.operatorId, tenantId: paid.tenantId },
        select: { id: true, endpoint: true, p256dh: true, auth: true, failCount: true },
      }),
    );
    const payload = JSON.stringify(payoutPushPayload(paid.payoutId, paid.totalCents));
    const outcomes = await Promise.all(subs.map((sub) => this.deliver(sub, payload, vapid)));
    return outcomes.filter((o) => o === 'sent').length;
  }

  private async deliver(sub: SubscriptionRow, payload: string, vapid: WebPushSettings): Promise<PushOutcome> {
    const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    const outcome = await pushWithRetries(this.send, target, payload, { vapid, ttlSeconds: PUSH_TTL_SECONDS, timeoutMs: PUSH_TIMEOUT_MS }, this.sleep);
    await this.record(sub, outcome).catch((err: unknown) => {
      this.logger.warn(`Aviso del pago: no se ha podido apuntar el resultado (${(err as Error)?.message ?? err})`);
    });
    return outcome;
  }

  private async record(sub: SubscriptionRow, outcome: PushOutcome): Promise<void> {
    await this.prisma.acrossVenues(async (tx) => {
      if (outcome === 'sent') {
        await tx.staffPushSubscription.updateMany({ where: { id: sub.id }, data: { failCount: 0, lastSentAt: new Date() } });
        return;
      }
      // Ya no existe (quitó el permiso o borró la app) o falla siempre: fuera.
      if (outcome === 'gone' || sub.failCount + 1 >= MAX_PUSH_FAILS) {
        await tx.staffPushSubscription.deleteMany({ where: { id: sub.id } });
        return;
      }
      await tx.staffPushSubscription.updateMany({ where: { id: sub.id }, data: { failCount: { increment: 1 } } });
    });
  }
}
