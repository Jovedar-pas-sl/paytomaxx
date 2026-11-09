import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { PAYMENT_DEVICE_EVENT } from './payment-device';

/** Días que se guarda la IP de los dispositivos de los cobros (DEVICE_IP_RETENTION_DAYS). */
export const DEVICE_IP_RETENTION_DAYS = 90;
/** Cada cuánto se borra lo caducado como mucho (lo lanza el repaso de cobros caducados, cada 10 min). */
export const DEVICE_IP_RETENTION_EVERY_S = 6 * 60 * 60;
/** Filas por vuelta (por local). */
export const DEVICE_IP_RETENTION_BATCH = 500;
/** Que no se repita antes de 6 h entre las réplicas. */
const LAST_RUN_KEY = 'np:device-ip-retention:last';

/** Los días de la variable (de 1 a 3650) o los 90 de siempre. */
export function retentionDaysOf(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEVICE_IP_RETENTION_DAYS;
}

/**
 * La IP de los dispositivos de los cobros (eventos `payment.device`) se borra
 * a los 90 días: queda el modelo, el sistema y el navegador, y `ipErased`.
 * Lo lanza un trabajo que ya existía (QrExpireSweepService, cada 10 min, con
 * su candado entre réplicas) y aquí se hace como mucho cada 6 h. Local a local
 * (el índice tenantId + eventType + occurredAt) y de 500 en 500. Lo del saldo
 * suelto va al registro sin IP: no hay nada que borrar.
 * NIGHTPAY_DISABLE_DEVICE_IP_RETENTION=1 lo apaga.
 */
@Injectable()
export class DeviceIpRetentionService {
  private readonly logger = new Logger(DeviceIpRetentionService.name);
  private readonly prisma: PrismaService;
  private readonly redis: Redis;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(REDIS_CLIENT) redis: Redis) {
    this.prisma = prisma;
    this.redis = redis;
  }

  /** Si toca (cada 6 h), borra las IP caducadas. Nunca lanza: lo llama otro repaso. */
  async maybeRun(now: Date = new Date()): Promise<number> {
    if (process.env.NIGHTPAY_DISABLE_DEVICE_IP_RETENTION === '1') return 0;
    try {
      if ((await this.redis.set(LAST_RUN_KEY, now.toISOString(), 'EX', DEVICE_IP_RETENTION_EVERY_S, 'NX')) !== 'OK') return 0;
      const erased = await this.eraseOld(now);
      if (erased > 0) this.logger.log(`IP de ${erased} dispositivo(s) de cobros de más de ${this.days()} días borradas`);
      return erased;
    } catch (err) {
      this.logger.error(`No se pudieron borrar las IP caducadas de los cobros: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Borra la IP de los `payment.device` de más de N días, local a local y de 500 en 500. Devuelve cuántas. */
  async eraseOld(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.days() * 24 * 60 * 60 * 1000);
    const venues = await this.prisma.asSystem((tx) => tx.venue.findMany({ select: { id: true } }));
    let erased = 0;
    for (const v of venues) {
      for (;;) {
        const n = await this.prisma.asSystem((tx) =>
          tx.$executeRaw`
            UPDATE payment_events
               SET payload = (payload - 'ip') || '{"ipErased": true}'::jsonb
             WHERE id IN (
               SELECT id FROM payment_events
                WHERE "tenantId" = ${v.id}::uuid
                  AND "eventType" = ${PAYMENT_DEVICE_EVENT}
                  AND "occurredAt" < ${cutoff}
                  AND payload ->> 'ip' IS NOT NULL
                LIMIT ${DEVICE_IP_RETENTION_BATCH}
             )
          `,
        );
        erased += n;
        if (n < DEVICE_IP_RETENTION_BATCH) break;
      }
    }
    return erased;
  }

  private days(): number {
    return retentionDaysOf(process.env.DEVICE_IP_RETENTION_DAYS);
  }
}
