import './bootstrap-env'; // PRIMERO — carga .env.local antes que cualquier modulo
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { redactSecretsInUrl } from './common/logging/redact-url';
import { ORIGIN_AUTH_HEADER, originAllowed } from './common/http/origin-guard';
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
    logger: {
      level: env.LOG_LEVEL,
      // El enlace del saldo (/w/<token>) es la credencial del cliente: no a los logs.
      serializers: {
        req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
          method: req.method,
          url: redactSecretsInUrl(req.url),
          hostname: req.hostname,
          remoteAddress: req.ip,
        }),
      },
    },
    bodyLimit: 1024 * 1024, // 1 MB max — webhooks normalmente <10KB
    // Default Fastify es 100; JWT en path (self-onboarding link, accept-invite)
    // tienen ~250 chars. Subimos a 500 para no rechazar tokens válidos con 404.
    maxParamLength: 500,
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
            // unsafe-inline necesario para el <script> auto-submit del
            // form de checkout en /pay/{token}. Sin esto, iOS Safari
            // bloquea el setTimeout(...).submit() y el cobro se queda
            // colgado en "Conectando con la pasarela de pago...".
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            // form-action: dominios a los que NightPay puede POSTear forms.
            // Sin esto, defaultSrc='self' restringe a api.paytomaxx.com
            // y bloquea cualquier submit a Redsys, Cecabank, Paytef, etc.
            formAction: [
              "'self'",
              'https://sis-t.redsys.es:25443',
              'https://sis.redsys.es',
              'https://tpv.ceca.es',
              'https://pgw.ceca.es',
              'https://api.paytef.es',
              'http://peanpe.com',
              'https://peanpe.com',
            ],
            frameAncestors: ["'none'"],
          },
        }
      : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  // Solo a través de Cloudflare (si está ORIGIN_AUTH_SECRET): lo que llegue
  // directo al servidor se corta antes de todo lo demás. El secreto se quita
  // de la petición para que no acabe en logs ni en Sentry.
  if (env.ORIGIN_AUTH_SECRET) {
    const secret = env.ORIGIN_AUTH_SECRET;
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', async (req: { headers: Record<string, string | string[] | undefined>; url: string }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
        const ok = originAllowed(req.headers, req.url, secret);
        delete req.headers[ORIGIN_AUTH_HEADER];
        if (!ok) return reply.code(403).send({ title: 'Forbidden', status: 403 });
      });
  }

  // Rate limit global — 100 req/min/IP. Endpoints sensibles (login, refresh,
  // accept-invite) tienen su propio @IpRateLimit más estricto via guard Redis.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(rateLimit as any, {
    max: 100,
    timeWindow: '1 minute',
    // La página del saldo del cliente consulta su estado cada pocos segundos y
    // en un local muchos clientes comparten la IP del wifi: va con su propio
    // límite (@IpRateLimit en PublicWalletController), no con el global.
    // "localhost" por la conexión real (req.ip sale de X-Forwarded-For y se puede inventar).
    allowList: (req: { method: string; url: string; raw?: { socket?: { remoteAddress?: string } } }) => {
      const peer = req.raw?.socket?.remoteAddress ?? '';
      return (
        peer === '127.0.0.1' ||
        peer === '::1' ||
        peer === '::ffff:127.0.0.1' ||
        (req.method === 'GET' && /^\/w\/[^/]+\/state(\?|$)/.test(req.url))
      );
    },
    keyGenerator: (req: { headers: Record<string, string | string[] | undefined>; ip: string }) => {
      // Detrás de Cloudflare: CF-Connecting-IP no lo puede falsear el cliente;
      // el primer valor de X-Forwarded-For sí.
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && cf) return cf;
      const xff = req.headers['x-forwarded-for'];
      return Array.isArray(xff) ? (xff[0] ?? req.ip) : ((xff as string | undefined) ?? req.ip);
    },
  });

  // /pay/:token es público para clientes que escanean QR — fuera del prefix /v1
  // para que el QR pueda apuntar a https://api.dominio.com/pay/{token}
  // (limpio, sin /v1 en la URL que llega al teléfono).
  // Fase 1B: también el POST de la página de pago, el formulario hacia el
  // banco y el justificante.
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'pay/:token', method: RequestMethod.GET },
      { path: 'pay/:token', method: RequestMethod.POST },
      { path: 'pay/:token/receipt', method: RequestMethod.GET },
      { path: 'pay/:token/checkout', method: RequestMethod.GET },
      // Recarga: el cliente activa Face ID o la suma a su saldo, en "Pagado".
      { path: 'pay/:token/passkey/options', method: RequestMethod.POST },
      { path: 'pay/:token/passkey', method: RequestMethod.POST },
      { path: 'pay/:token/merge/challenge', method: RequestMethod.POST },
      { path: 'pay/:token/merge', method: RequestMethod.POST },
      // Pagar con el saldo escaneando el QR de la chica (Face ID).
      { path: 's/:token', method: RequestMethod.GET },
      { path: 's/:token/challenge', method: RequestMethod.POST },
      { path: 's/:token/pay', method: RequestMethod.POST },
      // Saldo NightPay: página del cliente y sus acciones.
      { path: 'w/:token', method: RequestMethod.GET },
      { path: 'w/:token/state', method: RequestMethod.GET },
      { path: 'w/:token/requests/:id/accept', method: RequestMethod.POST },
      { path: 'w/:token/requests/:id/reject', method: RequestMethod.POST },
      { path: 'w/:token/close', method: RequestMethod.POST },
      { path: 'w/:token/passkey/options', method: RequestMethod.POST },
      { path: 'w/:token/passkey', method: RequestMethod.POST },
    ],
  });

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
