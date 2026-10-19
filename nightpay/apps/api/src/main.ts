import './bootstrap-env'; // PRIMERO — carga .env.local antes que cualquier modulo
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { httpLoggerOptions } from './common/logging/logger-options';
import { originAuthHook } from './common/http/origin-guard';
import { trustInternalProxy } from './common/http/client-ip';
import { corsOrigin, parseCorsOrigins } from './common/http/cors';
import { UNPREFIXED_ROUTES } from './common/http/unprefixed-routes';
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
/** Para recibir la petición entera (cabeceras + cuerpo de hasta 1 MB). */
const REQUEST_TIMEOUT_MS = 60_000;

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
    // Tokens de la URL tapados, IP de fiar y `redact` de cabeceras de sesión,
    // PIN, secretos y firmas de Redsys (common/logging/logger-options.ts).
    logger: httpLoggerOptions(env.LOG_LEVEL),
    bodyLimit: 1024 * 1024, // 1 MB max — webhooks normalmente <10KB
    // Default Fastify es 100; JWT en path (self-onboarding link, accept-invite)
    // tienen ~250 chars. Subimos a 500 para no rechazar tokens válidos con 404.
    // Fastify 5: las opciones del router van en `routerOptions` (FSTDEP022).
    routerOptions: { maxParamLength: 500 },
    // Cabeceras de proxy (X-Forwarded-*) solo de la red interna (Traefik).
    // Con `true`, req.ip era el primer X-Forwarded-For: lo que quisiera el cliente.
    trustProxy: trustInternalProxy,
    // Tiempo máximo para recibir la petición entera (Fastify lo deja en 0 =
    // sin límite: conexiones lentas a medias se quedarían abiertas).
    requestTimeout: REQUEST_TIMEOUT_MS,
    // Al apagar: 503 a lo nuevo y se cierran las conexiones inactivas
    // (keep-alive) para no esperar a que caduquen.
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    rawBody: true, // disponible en req.rawBody — usado solo en webhooks
  });

  // ─── Security middleware ──────────────────────────────────────────
  // Sin casts: con Fastify 5 pnpm resuelve una sola versión de fastify y los
  // tipos de los plugins cuadran (antes había 4.28 y 4.29 a la vez).
  await app.register(helmet, {
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
    // HSTS de 180 días, como hasta ahora: helmet 8 sube el valor por defecto
    // a 365. Subirlo es una decisión aparte (no cabe en la subida de versión).
    strictTransportSecurity: { maxAge: 180 * 24 * 60 * 60, includeSubDomains: true },
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
  await app.register(rateLimit, {
    max: GLOBAL_RATE_LIMIT_MAX,
    timeWindow: GLOBAL_RATE_LIMIT_WINDOW,
    allowList: isGlobalRateLimitExempt,
    keyGenerator: globalRateLimitKey,
  });

  // Las páginas del cliente (/pay, /w, /s) van fuera del prefijo /v1 para que
  // el QR apunte a https://api.dominio.com/pay/{token}, limpio. La lista (y
  // por qué cada acción nueva tiene que estar en ella), en unprefixed-routes.ts.
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });

  // CORS estricto via env CORS_ORIGINS (CSV). Dev: permite todo.
  const allowed = parseCorsOrigins(env.CORS_ORIGINS);
  app.enableCors({
    origin: corsOrigin(isProd, allowed),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });

  // Filtro global RFC 7807 — sin leaks de stack en produccion
  app.useGlobalFilters(new ProblemDetailsFilter(isProd));

  // Socket.io con Redis pub/sub adapter (ADR-001)
  app.useWebSocketAdapter(new RedisIoAdapter(app));

  // Apagado ordenado (SIGTERM de Docker/Dokploy): Nest cierra el servidor HTTP
  // y los sockets y ejecuta onModuleDestroy (Prisma, Redis, alertas, cierre
  // automático de noches). Sin esto el proceso moría a medias.
  app.enableShutdownHooks();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.log(`NightPay API escuchando en http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
}

bootstrap().catch((err: unknown) => {
  logger.error(`Fallo al arrancar: ${(err as Error)?.message ?? String(err)}`, (err as Error)?.stack);
  process.exit(1);
});
