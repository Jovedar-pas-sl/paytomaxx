import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PARTNER_FREEZES, type PartnerFreeze } from '@nightpay/contracts';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';

/** La copia en Redis de partner_api_state.freeze (60 s): se lee en cada petición. */
export const FREEZE_CACHE_KEY = 'np:partner-api:freeze';
export const FREEZE_CACHE_S = 60;

const isFreeze = (v: unknown): v is PartnerFreeze => typeof v === 'string' && (PARTNER_FREEZES as readonly string[]).includes(v);

/**
 * La congelación de la API de socios sin desplegar (super-admin con 2FA):
 * `all` = nada existe (404), `money` = sin cargas ni anulaciones (403). Sin la
 * copia de Redis, la fila; si Redis no responde, quien llama falla (503).
 */
@Injectable()
export class PartnerFreezeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async current(): Promise<PartnerFreeze> {
    const cached = await this.redis.get(FREEZE_CACHE_KEY);
    if (isFreeze(cached)) return cached;
    const row = await this.prisma.asSystem((tx) => tx.partnerApiState.findUnique({ where: { id: 1 }, select: { freeze: true } }));
    const value = isFreeze(row?.freeze) ? row.freeze : 'none';
    await this.publish(value);
    return value;
  }

  /** Tras cambiar la fila: vale ya en todas las réplicas (y, si no, a los 60 s). */
  async publish(value: PartnerFreeze): Promise<void> {
    await this.redis.set(FREEZE_CACHE_KEY, value, 'EX', FREEZE_CACHE_S);
  }
}
