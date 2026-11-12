import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { RELEASE_LOCK_LUA } from '../../common/redis/release-lock';
import { BtcpayInvoiceService } from './btcpay-invoice.service';
import { btcpayEnabled } from './btcpay-flag';

/** Cada cuánto se repasan las facturas de bitcoin abiertas (el respaldo del aviso). */
export const BTCPAY_SWEEP_EVERY_MS = 2 * 60 * 1000;
/** Primer repaso tras arrancar (sin estorbar el arranque). */
const BOOT_DELAY_MS = 45 * 1000;
const LOCK_KEY = 'np:btcpay-sweep:lock';
/** Solo por si la réplica se cae a mitad de vuelta: caduca sola antes de la siguiente. */
const LOCK_TTL_S = 100;

/**
 * Respaldo del aviso de BTCPay: cada 2 minutos mira las facturas abiertas por
 * si el aviso no llegó (BTCPay caído un rato, aviso perdido). Las mismas
 * comprobaciones estrictas que el aviso (BtcpayInvoiceService.processInvoice).
 * Una réplica a la vez (candado en Redis). Con BTCPAY_ENABLED apagado no hace nada.
 */
@Injectable()
export class BtcpaySweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BtcpaySweepService.name);
  private bootTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(BtcpayInvoiceService) private readonly invoices: BtcpayInvoiceService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    if (!btcpayEnabled() || process.env.NODE_ENV === 'test') return;
    this.bootTimer = setTimeout(() => void this.tick(), BOOT_DELAY_MS);
    this.bootTimer.unref();
    this.timer = setInterval(() => void this.tick(), BTCPAY_SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /** Una vuelta, si esta réplica toma el candado y el servidor tiene el bitcoin encendido. Nunca lanza. */
  async tick(now: Date = new Date()): Promise<void> {
    if (!btcpayEnabled()) return;
    const lock = randomUUID();
    try {
      if ((await this.redis.set(LOCK_KEY, lock, 'EX', LOCK_TTL_S, 'NX')) !== 'OK') return;
      try {
        const { checked, failed } = await this.invoices.sweepOpen(now);
        if (checked > 0 || failed > 0) this.logger.log(`Repaso de facturas de bitcoin: ${checked} comprobadas, ${failed} con error`);
      } finally {
        await this.redis.eval(RELEASE_LOCK_LUA, 1, LOCK_KEY, lock);
      }
    } catch (err) {
      this.logger.error(`Fallo en el repaso de facturas de bitcoin: ${(err as Error).message}`);
    }
  }
}
