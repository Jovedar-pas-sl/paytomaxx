import { Controller, Get, Inject, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Health } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly prisma: PrismaService;
  private readonly redis: Redis;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    this.prisma = prisma;
    this.redis = redis;
  }

  @Public()
  @Get()
  async get(): Promise<Health> {
    const checks: Record<string, 'ok' | 'fail' | 'skip'> = {
      api: 'ok',
      db: 'fail',
      redis: 'fail',
    };

    // DB ping
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.db = 'ok';
    } catch (err) {
      this.logger.warn(`DB health check failed: ${(err as Error).message}`);
    }

    // Redis ping — usa el client autenticado ya inyectado por RedisModule
    try {
      const result = await this.redis.ping();
      checks.redis = result === 'PONG' ? 'ok' : 'fail';
    } catch (err) {
      this.logger.warn(`Redis health check failed: ${(err as Error).message}`);
    }

    const overall = Object.values(checks).every((s) => s === 'ok') ? 'ok' : 'degraded';

    return {
      status: overall,
      version: process.env.npm_package_version ?? '0.0.0',
      timestamp: new Date().toISOString(),
      checks,
      // DIAG temporal — marker para confirmar deploy aplicado
      build: 'paytef-expiration-2026-05-15',
    } as Health & { build: string };
  }
}
