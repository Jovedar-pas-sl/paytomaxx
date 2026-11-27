import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { LOADS_PER_WALLET_MINUTE } from '@nightpay/contracts';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { lastNightCutoff, madridDay, nextNightCutoff } from '../../../common/time/madrid';
import { AuditService } from '../../audit/audit.service';
import type { PartnerAuth } from '../auth/current-connection.decorator';
import { partnerError } from '../http/partner-problem';

/**
 * Topes de lectura de saldos de la API de socios (ventanas fijas en Redis,
 * como `np:prl` del guard). Redis que falla: 503 try_later, nunca se deja
 * pasar a ciegas. El PR 3 suma aquí el de cargas por saldo.
 *
 *  - Freno de textos raros (`np:prl:scan:<conexión>:<minuto>`): solo los
 *    rechazos, los textos sin reconocer y los `OXC1:` mal formados; el 31.º
 *    del minuto, 429, y solo ese deja `partner.qr_scanning`.
 *  - Lecturas por saldo: 12 por minuto (`np:prl:bal`) y, por noche del local
 *    (`np:prl:balnight`, 48 h: el contador de disputas), 120 con código y 20
 *    con ficha. Va lo último antes del 200: solo cuentan las lecturas buenas.
 *    El primer 429 de cada saldo por cada tope, una vez al día por conexión,
 *    deja `partner.limit_exceeded` (el rastro de una clave que espía saldos).
 *  - Cargas por saldo (PR 3): 6 por minuto (`np:prl:wload`), con el saldo ya
 *    resuelto y bloqueado; la 7.ª, 429.
 */
export const PARTNER_WALLET_LIMITS = Object.freeze({
  scanPerMinute: 30,
  balancePerMinute: 12,
  balanceNight: { live: 120, ficha: 20 },
});

const MINUTE_TTL_S = 60;
const NIGHT_TTL_S = 48 * 3600;
const FIRST_TTL_S = 86_400;
const REDIS_DOWN_RETRY_S = 5;

export type PartnerRefKind = 'live_code' | 'ficha' | 'ficha_nfc';

export const PARTNER_WALLET_AUDIT = {
  qrScanning: 'partner.qr_scanning',
  limitExceeded: 'partner.limit_exceeded',
  masterLinkSubmitted: 'partner.master_link_submitted',
  cardCopySuspected: 'wallet.card_copy_suspected',
} as const;

const untilNextMinute = (now: number) => Math.max(1, 60 - Math.floor((now % 60_000) / 1000));

@Injectable()
export class PartnerWalletLimits {
  private readonly logger = new Logger(PartnerWalletLimits.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Un texto que no es ni código ni ficha (A3.1): el freno por conexión. */
  async scan(auth: PartnerAuth): Promise<void> {
    const now = Date.now();
    const conn = auth.connection;
    const n = await this.count(`np:prl:scan:${conn.id}:${Math.floor(now / 60_000)}`, MINUTE_TTL_S);
    if (n <= PARTNER_WALLET_LIMITS.scanPerMinute) return;
    if (n === PARTNER_WALLET_LIMITS.scanPerMinute + 1) {
      await this.audit.log({
        action: PARTNER_WALLET_AUDIT.qrScanning,
        tenantId: conn.tenantId,
        targetType: 'PartnerConnection',
        targetId: conn.id,
        payload: { connectionId: conn.id, keyHint: auth.keyHint },
      });
    }
    throw partnerError('rate_limited', {}, untilNextMinute(now));
  }

  /** Una lectura del saldo vivo `walletId` que va a responder 200 (lo último antes de responder). */
  async balance(auth: PartnerAuth, walletId: string, refKind: PartnerRefKind): Promise<void> {
    const now = new Date();
    const conn = auth.connection;
    const perMinute = await this.count(`np:prl:bal:${conn.id}:${walletId}:${Math.floor(now.getTime() / 60_000)}`, MINUTE_TTL_S);
    if (perMinute > PARTNER_WALLET_LIMITS.balancePerMinute) {
      await this.firstRefusal(auth, 'bal', walletId, refKind);
      throw partnerError('rate_limited', {}, untilNextMinute(now.getTime()));
    }
    const kind = refKind === 'live_code' ? 'live' : 'ficha';
    const businessDate = madridDay(lastNightCutoff(now));
    const night = await this.count(`np:prl:balnight:${kind}:${conn.id}:${walletId}:${businessDate}`, NIGHT_TTL_S);
    if (night > PARTNER_WALLET_LIMITS.balanceNight[kind]) {
      await this.firstRefusal(auth, 'balnight', walletId, refKind);
      throw partnerError('rate_limited', {}, Math.max(1, Math.ceil((nextNightCutoff(now).getTime() - now.getTime()) / 1000)));
    }
  }

  /** Una carga en el saldo vivo `walletId` (dentro de su transacción): la 7.ª del minuto, 429. */
  async loadsPerWallet(auth: PartnerAuth, walletId: string): Promise<void> {
    const now = Date.now();
    const n = await this.count(`np:prl:wload:${auth.connection.id}:${walletId}:${Math.floor(now / 60_000)}`, MINUTE_TTL_S);
    if (n > LOADS_PER_WALLET_MINUTE) throw partnerError('rate_limited', {}, untilNextMinute(now));
  }

  /** El primer 429 de este saldo por este tope, hoy y para esta conexión: al registro (sin aviso). */
  private async firstRefusal(auth: PartnerAuth, limit: 'bal' | 'balnight', walletId: string, refKind: PartnerRefKind): Promise<void> {
    const conn = auth.connection;
    let first = true;
    try {
      first = (await this.redis.set(`np:pwref:${limit}:${conn.id}:${walletId}`, '1', 'EX', FIRST_TTL_S, 'NX')) === 'OK';
    } catch (err) {
      // Sin poder saber si es el primero: se registra igual.
      this.logger.warn(`API de socios: tope de saldo sin marca (${(err as Error).message})`);
    }
    if (!first) return;
    await this.audit.log({
      action: PARTNER_WALLET_AUDIT.limitExceeded,
      tenantId: conn.tenantId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: {
        connectionId: conn.id,
        keyHint: auth.keyHint,
        name: conn.partner.name,
        limit: limit === 'bal' ? 'balance_minute' : 'balance_night',
        refKind,
      },
    });
  }

  private async count(key: string, ttlS: number): Promise<number> {
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, ttlS);
      return n;
    } catch (err) {
      this.logger.warn(`API de socios: Redis no responde en los topes de saldo (${(err as Error).message}): 503`);
      throw partnerError('try_later', {}, REDIS_DOWN_RETRY_S);
    }
  }
}
