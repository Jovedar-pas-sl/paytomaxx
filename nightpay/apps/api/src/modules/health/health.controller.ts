import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Health } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly prisma: PrismaService;
  private readonly config: ConfigService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.prisma = prisma;
    this.config = config;
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

    // Redis ping — usamos fetch al socket Redis a traves de ioredis instance
    // No tenemos un Redis client expuesto globalmente; usamos un check simple via TCP.
    try {
      const url = new URL(this.config.getOrThrow<string>('REDIS_URL'));
      const ok = await pingRedis(url.hostname, Number(url.port || 6379), 1500);
      checks.redis = ok ? 'ok' : 'fail';
    } catch (err) {
      this.logger.warn(`Redis health check failed: ${(err as Error).message}`);
    }

    const overall = Object.values(checks).every((s) => s === 'ok') ? 'ok' : 'degraded';

    return {
      status: overall,
      version: process.env.npm_package_version ?? '0.0.0',
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}

/**
 * Ping minimo a Redis: abre TCP, manda PING, espera +PONG.
 * Sin dependencias adicionales. Timeout corto para no bloquear health.
 */
async function pingRedis(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const done = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
    socket.once('data', (data) => {
      done(data.toString().startsWith('+PONG'));
    });
    socket.connect(port, host, () => {
      socket.write('PING\r\n');
    });
  });
}
