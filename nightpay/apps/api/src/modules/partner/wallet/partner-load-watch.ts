import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CASH_LIMIT_CENTS, PARTNER_SCOPES, type PartnerLoadLimit, type PartnerPauseReason } from '@nightpay/contracts';
import { reportError } from '../../../common/observability/sentry';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { lastNightCutoff, madridDay } from '../../../common/time/madrid';
import { AuditService } from '../../audit/audit.service';
import type { PartnerAuth } from '../auth/current-connection.decorator';
import { PARTNER_AUDIT, partnerAuditPayload } from '../partner-audit';
import { refusalMember } from './partner-load-rules';
import { apiVoidsSince, deviceCashSince, loadsSince } from './partner-loads.sql';

/**
 * Lo que se vigila de las cargas de una conexión, después de responder (A9):
 * nunca retrasa ni cambia una respuesta. Un fallo de Redis va al log; una
 * pausa que no se guarda, al log y a Sentry.
 *
 * Pausa de `wallet:load` (una vez, en su transacción), solo por:
 *  - `load_refusals`: 3 rechazos `per_operation` en 10 minutos deslizantes
 *    (la misma petición repetida cuenta una vez);
 *  - `load_burst`: más de 30 cargas nuevas en un minuto;
 *  - `load_voids`: 3 anulaciones de la plataforma (por la API) en la noche.
 *
 * Avisos: `partner.limit_exceeded` (el primero por conexión, saldo, tope y
 * día al registro; el primero por conexión y noche también al dueño), la
 * mitad y el total del tope de la noche, y el efectivo troceado por cajero.
 */
export const PARTNER_LOAD_WATCH = Object.freeze({
  refusalsToPause: 3,
  refusalWindowMs: 10 * 60_000,
  burstPerMinute: 30,
  apiVoidsToPause: 3,
  splitWindowMs: 60 * 60_000,
});

export const PARTNER_LOAD_AUDIT = {
  loaded: 'partner.wallet.loaded',
  voided: 'partner.wallet.load_voided',
  voidedByVenue: 'partner.wallet.load_voided_by_venue',
  limitExceeded: 'partner.limit_exceeded',
  nightHalf: 'partner.loads.night_half',
  nightFull: 'partner.loads.night_full',
  cashSplit: 'partner.cash_split_suspected',
  capsChanged: 'partner.caps_changed',
} as const;

const DAY_S = 86_400;
const NIGHT_KEY_S = 48 * 3600;

/** La carga nueva (201) que acaba de salir. */
export interface LoadDone {
  walletId: string;
  amountCents: number;
  device: string | null;
  /** Lo cargado esta noche por la conexión, ya con esta carga, y su tope. */
  nightTotalCents: number;
  nightCapCents: number;
  now: Date;
}

/** Un `402` de una carga: el tope (del contrato, o `cash`) y lo que se pedía. */
export interface LoadRefused {
  walletId: string;
  limit: PartnerLoadLimit | 'cash';
  amountCents: number;
  idempotencyKey: string;
  requestHash: string;
  now: Date;
}

@Injectable()
export class PartnerLoadWatch {
  private readonly logger = new Logger(PartnerLoadWatch.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Tras un 201 nuevo (no repetido): la ráfaga, la mitad y el total de la noche, y el troceo por cajero. */
  async loaded(auth: PartnerAuth, load: LoadDone): Promise<void> {
    const conn = auth.connection;
    const businessDate = madridDay(lastNightCutoff(load.now));
    const burst = await this.safely('ráfaga', () =>
      this.prisma.asSystem((tx) =>
        loadsSince(tx, { tenantId: conn.tenantId, connectionId: conn.id, since: new Date(load.now.getTime() - 60_000) }),
      ),
    );
    if (burst !== null && burst > PARTNER_LOAD_WATCH.burstPerMinute) await this.pause(auth, 'load_burst');
    const before = load.nightTotalCents - load.amountCents;
    const half = load.nightCapCents / 2;
    if (before < half && load.nightTotalCents >= half) await this.nightMark(auth, 'half', businessDate, load.nightTotalCents, load.nightCapCents);
    if (load.nightTotalCents >= load.nightCapCents) await this.nightMark(auth, 'full', businessDate, load.nightTotalCents, load.nightCapCents);
    await this.split(auth, load, businessDate);
  }

  /** Tras un 402: su registro (y el primero de la noche, al dueño); `per_operation` cuenta para la pausa. */
  async refused(auth: PartnerAuth, r: LoadRefused): Promise<void> {
    const conn = auth.connection;
    const businessDate = madridDay(lastNightCutoff(r.now));
    const firstHere = await this.firstMark(`np:pwref:load-${r.limit}:${conn.id}:${r.walletId}`, DAY_S);
    const firstNight = await this.firstMark(`np:plim-alert:${conn.id}:${businessDate}`, NIGHT_KEY_S);
    if (firstHere || firstNight) {
      await this.audit.log({
        action: PARTNER_LOAD_AUDIT.limitExceeded,
        tenantId: conn.tenantId,
        targetType: 'ClientWallet',
        targetId: r.walletId,
        payload: {
          connectionId: conn.id,
          keyHint: auth.keyHint,
          name: conn.partner.name,
          limit: r.limit,
          amountCents: r.amountCents,
          // §6.6 del diseño: «first cap hit per night», al dueño.
          ...(firstNight ? { ownerAlert: true } : {}),
        },
      });
    }
    if (r.limit === 'connection_night') {
      await this.nightMark(auth, 'full', businessDate, conn.loadNightMaxCents, conn.loadNightMaxCents);
    }
    if (r.limit === 'per_operation') await this.perOperationRefusal(auth, r);
  }

  /** Tras una anulación nueva por la API: la 3.ª de la noche pausa (las del panel no cuentan). */
  async apiVoided(auth: PartnerAuth, now: Date): Promise<void> {
    const conn = auth.connection;
    const voids = await this.safely('anulaciones', () =>
      this.prisma.asSystem((tx) => apiVoidsSince(tx, { tenantId: conn.tenantId, connectionId: conn.id, since: lastNightCutoff(now) })),
    );
    if (voids !== null && voids >= PARTNER_LOAD_WATCH.apiVoidsToPause) await this.pause(auth, 'load_voids');
  }

  /** 3 rechazos por `per_operation` en 10 minutos deslizantes (ZSET por conexión). */
  private async perOperationRefusal(auth: PartnerAuth, r: LoadRefused): Promise<void> {
    const key = `np:pap:po:${auth.connection.id}`;
    const ms = r.now.getTime();
    const count = await this.safely('rechazos', async () => {
      await this.redis.zadd(key, ms, refusalMember(r.idempotencyKey, r.requestHash));
      await this.redis.zremrangebyscore(key, '-inf', ms - PARTNER_LOAD_WATCH.refusalWindowMs - 1);
      await this.redis.expire(key, PARTNER_LOAD_WATCH.refusalWindowMs / 1000);
      return this.redis.zcard(key);
    });
    if (count !== null && count >= PARTNER_LOAD_WATCH.refusalsToPause) await this.pause(auth, 'load_refusals');
  }

  /** La mitad o el total del tope de la noche: un aviso al dueño por noche. */
  private async nightMark(auth: PartnerAuth, which: 'half' | 'full', businessDate: string, totalCents: number, capCents: number): Promise<void> {
    const conn = auth.connection;
    if (!(await this.firstMark(`np:pnight-${which}:${conn.id}:${businessDate}`, NIGHT_KEY_S))) return;
    await this.audit.log({
      action: which === 'half' ? PARTNER_LOAD_AUDIT.nightHalf : PARTNER_LOAD_AUDIT.nightFull,
      tenantId: conn.tenantId,
      targetType: 'PartnerConnection',
      targetId: conn.id,
      payload: { connectionId: conn.id, name: conn.partner.name, amountCents: totalCents, capCents, businessDate },
    });
  }

  /**
   * Efectivo troceado (como watchSplit de recepción, pero por conexión y
   * cajero; sin `device`, todas juntas como un cajero más): varios saldos que
   * juntos pasan de 1.000 € en una hora. Un aviso por cajero y noche.
   */
  private async split(auth: PartnerAuth, load: LoadDone, businessDate: string): Promise<void> {
    const conn = auth.connection;
    const cash = await this.safely('troceo', () =>
      this.prisma.asSystem((tx) =>
        deviceCashSince(tx, {
          tenantId: conn.tenantId,
          connectionId: conn.id,
          device: load.device,
          since: new Date(load.now.getTime() - PARTNER_LOAD_WATCH.splitWindowMs),
        }),
      ),
    );
    if (!cash || cash.wallets < 2 || cash.total < CASH_LIMIT_CENTS) return;
    if (!(await this.firstMark(`np:psplit:${conn.id}:${load.device ?? '-'}:${businessDate}`, NIGHT_KEY_S))) return;
    await this.audit.log({
      action: PARTNER_LOAD_AUDIT.cashSplit,
      tenantId: conn.tenantId,
      targetType: 'PartnerConnection',
      targetId: conn.id,
      payload: { connectionId: conn.id, name: conn.partner.name, amountCents: cash.total, wallets: cash.wallets, device: load.device },
    });
  }

  /**
   * Pausa `wallet:load` de la conexión (pausedScopes y pausedReason), una vez:
   * con la fila bloqueada, solo si está activa y aún no la tiene en pausa.
   */
  async pause(auth: PartnerAuth, reason: Extract<PartnerPauseReason, 'load_refusals' | 'load_burst' | 'load_voids'>): Promise<void> {
    const conn = auth.connection;
    try {
      await this.prisma.asSystem(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ status: string; scopes: string[]; pausedScopes: string[] }>>`
          SELECT status::text AS status, scopes, "pausedScopes" FROM partner_connections
           WHERE id = ${conn.id}::uuid AND "tenantId" = ${conn.tenantId}::uuid FOR UPDATE`;
        if (!row || row.status !== 'ACTIVE' || !row.scopes.includes('wallet:load') || row.pausedScopes.includes('wallet:load')) return;
        const paused = new Set([...row.pausedScopes, 'wallet:load']);
        await tx.partnerConnection.update({
          where: { id: conn.id, tenantId: conn.tenantId },
          data: { pausedScopes: PARTNER_SCOPES.filter((s) => paused.has(s)), pausedReason: reason },
        });
        await this.audit.logInTx(tx, {
          action: PARTNER_AUDIT.connectionPaused,
          tenantId: conn.tenantId,
          targetType: 'PartnerConnection',
          targetId: conn.id,
          payload: partnerAuditPayload(conn, { reason }),
        });
      });
    } catch (err) {
      this.logger.error(`API de socios: la pausa ${reason} de la conexión ${conn.id} no se ha guardado (${(err as Error).name})`);
      reportError(err instanceof Error ? err : new Error(String(err)), { tag: 'partner.load_pause' });
    }
  }

  /** La primera vez (SET NX); si Redis falla, se registra igual (al log que no se pudo marcar). */
  private async firstMark(key: string, ttlS: number): Promise<boolean> {
    try {
      return (await this.redis.set(key, '1', 'EX', ttlS, 'NX')) === 'OK';
    } catch (err) {
      this.logger.warn(`API de socios: aviso de cargas sin marca en Redis (${(err as Error).name})`);
      return true;
    }
  }

  /** Lo que falla aquí va al log (solo el tipo) y no cambia nada. */
  private async safely<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(`API de socios: vigilancia de cargas (${what}) sin hacer (${(err as Error).name})`);
      return null;
    }
  }
}
