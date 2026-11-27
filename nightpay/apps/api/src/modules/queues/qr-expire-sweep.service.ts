import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { RELEASE_LOCK_LUA } from '../../common/redis/release-lock';
import { DeviceIpRetentionService } from '../payments/device-ip-retention.service';
import { PaymentsService } from '../payments/payments.service';
import { expireIfStillOpen } from './qr-expire.processor';

/** Cada cuánto se repasan los cobros caducados. */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
/** Primer repaso tras arrancar (sin estorbar el arranque). */
const BOOT_DELAY_MS = 90 * 1000;
/** Margen tras el plazo: antes le toca al trabajo qr-expire (y a sus reintentos). */
const GRACE_MS = 5 * 60 * 1000;
/** Como mucho tantos por repaso (el resto, en el siguiente). */
const BATCH_SIZE = 200;
/**
 * Nunca dos repasos a la vez entre las réplicas (con start-first conviven dos
 * un rato): la que toma el candado (con un valor suyo) barre y lo suelta al
 * terminar, solo si sigue siendo suyo. Antes se quedaba puesto 9 min: el
 * repaso del arranque (a los 90 s) dejaba sin hacer la primera vuelta de los
 * 10 min y la primera caducidad llegaba a los ~20 min (prueba real). Que las
 * dos réplicas barran en el mismo intervalo no hace nada dos veces (la fila
 * bloqueada decide).
 */
const LOCK_KEY = 'np:qr-expire-sweep:lock';
/** Solo por si la réplica se cae a mitad de vuelta: caduca sola antes de la siguiente. */
const LOCK_TTL_S = 9 * 60;

/**
 * Cobros que siguen CREATED/AWAITING_CAPTURE pasado su plazo (qrExpiresAt):
 * su trabajo qr-expire no llegó a encolarse (Redis falló justo después de
 * guardar el cobro y el reintento con la misma Idempotency-Key lo devuelve
 * sin volver a encolar) o agotó sus reintentos. Sin esto se quedaban abiertos
 * para siempre en los listados por estado. Se caducan con la misma transición
 * que el trabajo (expireIfStillOpen): repetirlo, o que el trabajo llegue a la
 * vez, no hace nada dos veces (la fila bloqueada decide).
 */
@Injectable()
export class QrExpireSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QrExpireSweepService.name);
  private readonly prisma: PrismaService;
  private readonly payments: PaymentsService;
  private readonly redis: Redis;
  private bootTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** Borrar a los 90 días la IP de los dispositivos de los cobros (como mucho cada 6 h): va en este mismo repaso. */
  private readonly ipRetention: DeviceIpRetentionService | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Optional() @Inject(DeviceIpRetentionService) ipRetention?: DeviceIpRetentionService,
  ) {
    this.prisma = prisma;
    this.payments = payments;
    this.redis = redis;
    this.ipRetention = ipRetention ?? null;
  }

  onModuleInit(): void {
    if (process.env.NIGHTPAY_DISABLE_QR_EXPIRE_SWEEP === '1' || process.env.NODE_ENV === 'test') return;
    this.bootTimer = setTimeout(() => void this.tick(), BOOT_DELAY_MS);
    this.bootTimer.unref();
    this.timer = setInterval(() => void this.tick(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /** Una vuelta, si esta réplica toma el candado; al terminar (también si falla), lo suelta. Nunca lanza. */
  async tick(now: Date = new Date()): Promise<void> {
    const lock = randomUUID();
    try {
      if ((await this.redis.set(LOCK_KEY, lock, 'EX', LOCK_TTL_S, 'NX')) !== 'OK') return;
      try {
        const { expired, failed } = await this.sweep(now);
        if (expired > 0 || failed > 0) {
          this.logger.warn(`Cobros caducados sin su trabajo de caducidad: ${expired} caducados, ${failed} con error`);
        }
        // Con el mismo candado: la IP de los dispositivos de los cobros, a los 90 días (cada 6 h; nunca lanza).
        await this.ipRetention?.maybeRun(now);
        await this.bankChecks(now);
      } finally {
        await this.redis.eval(RELEASE_LOCK_LUA, 1, LOCK_KEY, lock);
      }
    } catch (err) {
      this.logger.error(`Fallo en el repaso de cobros caducados: ${(err as Error).message}`);
    }
  }

  /** Volver a preguntar al banco por los cobros que lo necesitan (PaymentsService.requeueBankChecks). Nunca lanza. */
  private async bankChecks(now: Date): Promise<void> {
    try {
      const { authorizing, canceled } = await this.payments.requeueBankChecks(now);
      if (authorizing > 0) this.logger.warn(`Repaso del banco: ${authorizing} cobros «Comprobando…» sin su comprobación, vueltos a pedir`);
      if (canceled > 0) this.logger.log(`Repaso del banco: ${canceled} cancelados recientes vueltos a mirar`);
    } catch (err) {
      this.logger.error(`No se pudo pedir el repaso del banco: ${(err as Error).message}`);
    }
  }

  async sweep(now: Date = new Date()): Promise<{ expired: number; skipped: number; failed: number }> {
    // De todos los locales a propósito (sin local en el contexto: asSystem).
    const due = await this.prisma.asSystem((tx) =>
      tx.payment.findMany({
        where: {
          status: { in: ['CREATED', 'AWAITING_CAPTURE'] },
          qrExpiresAt: { lt: new Date(now.getTime() - GRACE_MS) },
        },
        orderBy: { qrExpiresAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true },
      }),
    );
    let expired = 0;
    let skipped = 0;
    let failed = 0;
    for (const p of due) {
      try {
        if (await expireIfStillOpen(this.payments, p.id)) expired += 1;
        else skipped += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(`No se pudo caducar el cobro ${p.id}: ${(err as Error).message}`);
      }
    }
    return { expired, skipped, failed };
  }
}
