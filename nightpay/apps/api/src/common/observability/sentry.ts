/**
 * Sentry wrapper — soft-dependency (no crashea si @sentry/node no está instalado).
 *
 * Cargamos el SDK con require lazy y try/catch para que el API arranque incluso
 * si el dev no ha hecho `pnpm install` después del bump de package.json.
 *
 * En prod con SENTRY_DSN configurado y @sentry/node instalado: full SDK activo.
 * Sin DSN o sin paquete: no-op silencioso (en prod un WARN).
 */

import { scrubBreadcrumb, scrubSensitive } from './sentry-scrub';

export { scrubBreadcrumb, scrubSensitive };

interface SentryLike {
  init: (opts: Record<string, unknown>) => void;
  captureException: (err: unknown) => void;
  withScope: (cb: (scope: SentryScope) => void) => void;
  httpIntegration?: () => unknown;
  nativeNodeFetchIntegration?: () => unknown;
}

interface SentryScope {
  setTag: (k: string, v: string) => void;
  setUser: (u: { id?: string }) => void;
}

let Sentry: SentryLike | null = null;
let initialized = false;

function loadSentry(): SentryLike | null {
  if (Sentry) return Sentry;
  try {
     
    Sentry = require('@sentry/node') as SentryLike;
    return Sentry;
  } catch {
    return null;
  }
}

export function initSentry(env: {
  SENTRY_DSN?: string;
  NODE_ENV?: string;
  GIT_SHA?: string;
}): void {
  if (initialized) return;
  if (!env.SENTRY_DSN) {
    if (env.NODE_ENV === 'production') {
       
      console.warn(
        '[observability] SENTRY_DSN no configurado en prod — errores solo van a stdout',
      );
    }
    return;
  }
  const sdk = loadSentry();
  if (!sdk) {
     
    console.warn(
      '[observability] @sentry/node no instalado — saltando init (pnpm install para activar)',
    );
    return;
  }
  const integrations: unknown[] = [];
  if (sdk.httpIntegration) integrations.push(sdk.httpIntegration());
  if (sdk.nativeNodeFetchIntegration) integrations.push(sdk.nativeNodeFetchIntegration());
  sdk.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV ?? 'development',
    release: env.GIT_SHA,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
    integrations,
    beforeSend(event: Record<string, unknown>) {
      return scrubSensitive(event);
    },
    // Las trazas de rendimiento llevan la URL de cada petición: misma limpieza.
    beforeSendTransaction(event: Record<string, unknown>) {
      return scrubSensitive(event);
    },
    // Llamadas salientes (Telegram lleva el token en la ruta; los exploradores
    // la clave en la query): limpias antes de guardarse en el breadcrumb.
    beforeBreadcrumb(breadcrumb: Record<string, unknown>) {
      return scrubBreadcrumb(breadcrumb);
    },
  });
  initialized = true;
   
  console.log('[observability] Sentry initialized');
}

export function reportError(
  err: unknown,
  context?: { tenantId?: string; userId?: string; tag?: string },
): void {
  if (!initialized || !Sentry) return;
  Sentry.withScope((scope) => {
    if (context?.tenantId) scope.setTag('tenantId', context.tenantId);
    if (context?.userId) scope.setUser({ id: context.userId });
    if (context?.tag) scope.setTag('module', context.tag);
    Sentry!.captureException(err);
  });
}
