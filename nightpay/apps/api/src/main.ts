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
import { initSentry } from './common/observability/sentry';
import { RedisIoAdapter } from './modules/realtime/realtime.adapter';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';

async function bootstrap() {
  const env = loadEnv();
  const isProd = env.NODE_ENV === 'production';

  // Sentry primero — para capturar fallos de bootstrap
  initSentry({
    SENTRY_DSN: env.SENTRY_DSN,
    NODE_ENV: env.NODE_ENV,
    GIT_SHA: env.GIT_SHA,
  });

  const adapter = new FastifyAdapter({
    logger: { level: env.LOG_LEVEL },
    bodyLimit: 1024 * 1024, // 1 MB max — webhooks normalmente <10KB
    trustProxy: true, // detras de Cloudflare/Coolify
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    rawBody: true, // disponible en req.rawBody — usado solo en webhooks
  });

  // ─── Security middleware ──────────────────────────────────────────
  // Casts a FastifyPluginCallback son por incompatibilidad de tipos entre
  // multiples versiones de fastify resueltas por pnpm (4.28.x vs 4.29.x).
  // Funcionan correctamente en runtime — solo molesta a tsc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(helmet as any, {
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

  // Rate limit global — 100 req/min/IP. Endpoints sensibles (login, refresh,
  // accept-invite) tienen su propio @IpRateLimit más estricto via guard Redis.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(rateLimit as any, {
    max: 100,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
    keyGenerator: (req: { headers: Record<string, string | string[] | undefined>; ip: string }) => {
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
