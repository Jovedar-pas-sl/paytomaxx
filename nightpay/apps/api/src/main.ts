import './bootstrap-env'; // PRIMERO — carga .env.local antes que cualquier modulo
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger, RequestMethod } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { redactSecretsInUrl } from './common/logging/redact-url';
import { originAuthHook } from './common/http/origin-guard';
import { clientIp, trustInternalProxy, type ClientIpRequest } from './common/http/client-ip';
import {
  GLOBAL_RATE_LIMIT_MAX,
  GLOBAL_RATE_LIMIT_WINDOW,
  globalRateLimitKey,
  isGlobalRateLimitExempt,
} from './common/http/global-rate-limit';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { envWarnings } from './config/env-warnings';
import { initSentry } from './common/observability/sentry';
import { RedisIoAdapter } from './modules/realtime/realtime.adapter';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const env = loadEnv();
  const isProd = env.NODE_ENV === 'production';
  // Lo que no impide arrancar pero hay que corregir (ver config/env-warnings.ts).
  for (const warning of envWarnings(env)) logger.warn(warning);

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
        req: (req: ClientIpRequest & { method: string; url: string; hostname?: string }) => ({
          method: req.method,
          url: redactSecretsInUrl(req.url),
          hostname: req.hostname,
          remoteAddress: clientIp(req) ?? undefined,
        }),
      },
    },
    bodyLimit: 1024 * 1024, // 1 MB max — webhooks normalmente <10KB
    // Default Fastify es 100; JWT en path (self-onboarding link, accept-invite)
    // tienen ~250 chars. Subimos a 500 para no rechazar tokens válidos con 404.
    maxParamLength: 500,
    // Cabeceras de proxy (X-Forwarded-*) solo de la red interna (Traefik).
    // Con `true`, req.ip era el primer X-Forwarded-For: lo que quisiera el cliente.
    trustProxy: trustInternalProxy,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    rawBody: true, // disponible en req.rawBody — usado solo en webhooks
  });

  // ─── Security middleware ──────────────────────────────────────────
  // Casts a FastifyPluginCallback son por incompatibilidad de tipos entre
  // multiples versiones de fastify resueltas por pnpm (4.28.x vs 4.29.x).
  // Funcionan correctamente en runtime — solo molesta a tsc.
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
  // directo al servidor se corta antes de todo lo demás; lo que trae la
  // cabecera buena queda marcado (CF-Connecting-IP de fiar). El secreto se
  // quita de la petición para que no acabe en logs ni en Sentry.
  if (env.ORIGIN_AUTH_SECRET) {
    app.getHttpAdapter().getInstance().addHook('onRequest', originAuthHook(env.ORIGIN_AUTH_SECRET));
  }

  // Rate limit global por IP de fiar (common/http/client-ip.ts). Endpoints
  // sensibles (login, refresh, accept-invite) tienen además su @IpRateLimit.
  // Exentos: el sondeo del saldo (con su propio límite) y el healthcheck del
  // propio contenedor por loopback (ver global-rate-limit.ts).
  await app.register(rateLimit as any, {
    max: GLOBAL_RATE_LIMIT_MAX,
    timeWindow: GLOBAL_RATE_LIMIT_WINDOW,
    allowList: isGlobalRateLimitExempt,
    keyGenerator: globalRateLimitKey,
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
      { path: 'pay/:token/pin', method: RequestMethod.POST },
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
  logger.log(`NightPay API escuchando en http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
}

function parseCorsOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

bootstrap().catch((err: unknown) => {
  logger.error(`Fallo al arrancar: ${(err as Error)?.message ?? String(err)}`, (err as Error)?.stack);
  process.exit(1);
});
