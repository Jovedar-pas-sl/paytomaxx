import './bootstrap-env'; // PRIMERO — carga .env.local antes que cualquier modulo
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { RedisIoAdapter } from './modules/realtime/realtime.adapter';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';

async function bootstrap() {
  const env = loadEnv();
  const isProd = env.NODE_ENV === 'production';

  const adapter = new FastifyAdapter({
    logger: { level: env.LOG_LEVEL },
    bodyLimit: 1024 * 1024, // 1 MB max — webhooks normalmente <10KB
    trustProxy: true, // detras de Cloudflare/Coolify
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    rawBody: true, // disponible en req.rawBody — usado solo en webhooks
  });

  // ─── Security middleware ──────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
          },
        }
      : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  // Rate limit global — 200 req/min/IP (granular por endpoint en cada controller)
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
    keyGenerator: (req) => {
      const xff = req.headers['x-forwarded-for'];
      return Array.isArray(xff) ? (xff[0] ?? req.ip) : ((xff as string | undefined) ?? req.ip);
    },
  });

  app.setGlobalPrefix('v1');

  // CORS estricto via env CORS_ORIGINS (CSV). Dev: permite todo.
  const allowed = parseCorsOrigins(env.CORS_ORIGINS);
  app.enableCors({
    origin: isProd ? (allowed.length > 0 ? allowed : false) : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });

  // Filtro global RFC 7807 — sin leaks de stack en produccion
  app.useGlobalFilters(new ProblemDetailsFilter(isProd));

  // Socket.io con Redis pub/sub adapter (ADR-001)
  app.useWebSocketAdapter(new RedisIoAdapter(app));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`NightPay API listening on http://0.0.0.0:${env.PORT}`);
}

function parseCorsOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
