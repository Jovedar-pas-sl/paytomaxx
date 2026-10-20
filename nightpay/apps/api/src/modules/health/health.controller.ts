import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
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

  /**
   * Solo "el proceso responde": para el healthcheck de Docker. Si se cae la
   * base de datos, reiniciar el API no lo arregla (y lo dejaría reiniciando
   * en bucle), así que aquí no se mira.
   */
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Estado completo (API, base de datos, Redis). Si algo falla responde 503:
   * un monitor externo (UptimeRobot, Cloudflare…) lo detecta como caída.
   */
  @Public()
  @Get()
  async get(@Res({ passthrough: true }) res?: FastifyReply): Promise<Health> {
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
    if (overall !== 'ok') res?.status(503);

    return {
      status: overall,
      version: deployedVersion(),
      timestamp: new Date().toISOString(),
      checks,
      // Marca del despliegue: con ella el dueño comprueba que el deploy se aplicó.
      build: nonEmpty(process.env.BUILD_MARKER) ?? DEFAULT_BUILD_MARKER,
    } as Health & { build: string };
  }
}

const DEFAULT_BUILD_MARKER = 'revision3-2026-10-20';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** El commit desplegado (GIT_SHA, lo pone el Dockerfile); si no, la versión del paquete. */
function deployedVersion(): string {
  return nonEmpty(process.env.GIT_SHA) ?? nonEmpty(process.env.npm_package_version) ?? '0.0.0';
}
