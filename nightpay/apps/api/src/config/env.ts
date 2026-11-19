import { Logger } from '@nestjs/common';
import type { ConfigModuleOptions } from '@nestjs/config';
import { z } from 'zod';
import { LEGACY_SUBSCRIBE_UNTIL_HINT, isValidLegacySubscribeUntil } from './realtime-legacy';
import { AUTH_BODY_REFRESH_UNTIL_HINT, isValidAuthBodyRefreshUntil } from './auth-body-refresh';
import { DEFAULT_GOOGLE_WALLET_CLASS_SUFFIX } from './google-wallet';

/**
 * Secretos que en producción no pueden ser los de ejemplo: con ellos
 * cualquiera podría firmar sesiones o descifrar credenciales. env.spec.ts
 * comprueba que los de .env.example se rechazan.
 */
export const GUARDED_SECRETS = ['JWT_SECRET', 'COOKIE_SECRET', 'ENCRYPTION_KEK'] as const;
type GuardedSecret = (typeof GUARDED_SECRETS)[number];

/** Secretos de ejemplo de .env.example hasta el 2026-10-15. Valen en local. */
export const DEV_PLACEHOLDER_SECRETS: Readonly<Record<GuardedSecret, string>> = {
  JWT_SECRET: 'dev_jwt_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6_v1',
  COOKIE_SECRET: 'dev_cookie_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6_v1',
  ENCRYPTION_KEK: 'dev_kek_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6_v1',
};
/**
 * Lo que llevan los de ejemplo, los de antes (el relleno a1b2c3…) y los de
 * ahora (dev-jwt-solo-local-no-vale-en-produccion-…): uno que lo contenga,
 * aunque esté retocado, es de ejemplo. Ninguno sale de `openssl rand`.
 */
const EXAMPLE_SECRET_MARKERS = ['a1b2c3d4e5f6a1b2c3d4e5f6', 'solo-local', 'no-vale-en-produccion'] as const;

const EnvSchema = z.object({
  // Sin NODE_ENV se asume producción: CORS, CSP, cookies Secure, endpoints de
  // debug, métricas y detalle de errores dependen de él. En local lo pone
  // `pnpm dev` (src/dev.ts) o NODE_ENV=development en .env.local.
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(4100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >= 32 chars'),
  COOKIE_SECRET: z.string().min(32),
  ENCRYPTION_KEK: z.string().min(32),
  // Wipay = Cecabank TPV Virtual (Global Payment Systems).
  //   WIPAY_API_URL — endpoint hosted page del cliente. Sandbox:
  //     https://tpv.ceca.es/tpvweb/tpv/compra.action
  //     Prod: https://pgw.ceca.es/tpvweb/tpv/compra.action
  //   WIPAY_MERCHANT_ID/ACQUIRER_BIN/TERMINAL_ID/CLAVE_ENCRIPTACION son las
  //     4 credenciales que tu Entidad / Wipay te entrega al dar de alta el TPV.
  //   WIPAY_WEBHOOK_SECRET — DEPRECATED: el adapter actual no lo usa
  //     (Cecabank firma con SHA-256 + clave_encriptación, no HMAC).
  WIPAY_API_URL: z
    .string()
    .url()
    .default('https://tpv.ceca.es/tpvweb/tpv/compra.action'),
  WIPAY_MERCHANT_ID: z.string().regex(/^\d{1,9}$/, 'MerchantID = 1-9 dígitos').optional(),
  WIPAY_ACQUIRER_BIN: z.string().regex(/^\d{1,10}$/, 'AcquirerBIN = 1-10 dígitos').optional(),
  WIPAY_TERMINAL_ID: z.string().regex(/^\d{1,8}$/, 'TerminalID = 1-8 dígitos').optional(),
  WIPAY_CLAVE_ENCRIPTACION: z.string().min(4).optional(),
  WIPAY_WEBHOOK_SECRET: z.string().min(8).optional(),

  // Redsys SIS — protocolo estándar de pasarelas bancarias ES (BBVA,
  // Santander, CaixaBank, Sabadell). 3 credenciales:
  //   REDSYS_API_URL — endpoint hosted page del cliente. Sandbox:
  //     https://sis-t.redsys.es:25443/sis/realizarPago
  //     Prod: https://sis.redsys.es/sis/realizarPago
  //     Algunos bancos usan subdominio: bbvaempresas.redsys.es, etc.
  //   REDSYS_MERCHANT_CODE — código de comercio (9 dígitos, "FUC")
  //   REDSYS_TERMINAL — número de terminal (1-3 dígitos)
  //   REDSYS_SECRET_KEY — clave de firma base64 del banco
  REDSYS_API_URL: z
    .string()
    .url()
    .default('https://sis-t.redsys.es:25443/sis/realizarPago'),
  REDSYS_MERCHANT_CODE: z.string().regex(/^\d{1,9}$/, 'MerchantCode = 1-9 dígitos').optional(),
  REDSYS_TERMINAL: z.string().regex(/^\d{1,3}$/, 'Terminal = 1-3 dígitos').optional(),
  REDSYS_SECRET_KEY: z.string().min(8).optional(),
  // DS_MERCHANT_PAYMETHODS — fuerza el método de pago en la página hosted.
  // Valores típicos:
  //   "xpay"  → solo wallets (Apple Pay + Google Pay). Cliente sin wallet
  //             configurado NO puede pagar — usar solo cuando BBVA tiene
  //             Apple Pay + Google Pay activos en el TPV.
  //   "C"     → solo tarjeta tradicional (PAN+CVV).
  //   (vacío) → Redsys decide. Si BBVA activó wallets, los muestra como
  //             botones JUNTO al form de tarjeta. Default seguro.
  //
  // Recomendado: dejarlo VACÍO. Con Apple Pay + Google Pay activos en BBVA
  // (oct-2026) los botones salen solos junto al form de tarjeta. "xpay" es
  // global: el cliente sin wallet, o que abre el enlace dentro de Instagram,
  // no podría pagar.
  // Desde la Fase 1B el cliente elige el botón en /pay/{token} y eso manda;
  // esta variable solo cuenta para cobros que no pasan por esa página.
  REDSYS_PAYMETHODS: z.string().optional(),
  // Nombre con el que sale el cobro en el extracto del cliente (lo fija
  // BBVA). Se enseña en la página de pago para evitar "no lo reconozco".
  // Vacío = no se enseña.
  PAY_STATEMENT_NAME: z.string().max(40).optional(),
  // Página de pago en el móvil: el botón principal abre directamente Apple
  // Pay / Google Pay (pedido "xpay"). false → un solo botón hacia la página
  // del banco (tarjeta y lo que BBVA tenga activo). Apágalo si BBVA no tiene
  // xpay en el TPV: si no, el botón principal no deja pagar.
  PAY_DIRECT_WALLET: z
    .union([z.boolean(), z.string().transform((s) => !['false', '0', 'no', 'off'].includes(s.trim().toLowerCase()))])
    .default(true),
  // «Pagar con bitcoin» (BTCPay Server). Apagado por defecto: sin esto no hay
  // rutas (404), ni botón, ni repaso de facturas, y cada local además tiene que
  // activarlo en Ajustes. Ver modules/btcpay.
  BTCPAY_ENABLED: z
    .union([z.boolean(), z.string().transform((s) => ['true', '1', 'yes', 'on'].includes(s.trim().toLowerCase()))])
    .default(false),
  // OxioCard (alta de la compañera): «Abrir mi OxioCard» solo apunta la
  // petición y su estado (lo cambia a mano el dueño). Apagado por defecto: sin
  // esto no sale en ninguna pantalla y su ruta da 404.
  OXIOCARD_ENABLED: z
    .union([z.boolean(), z.string().transform((s) => ['true', '1', 'yes', 'on'].includes(s.trim().toLowerCase()))])
    .default(false),
  // Nombre de la marca en pantallas, concepto del cobro y correos (por
  // defecto OxioPay). No cambia el extracto del banco: eso lo fija BBVA.
  BRAND_NAME: z.string().trim().min(2).max(20).optional(),
  // Nombre del comercio en la página de pago de Redsys y en el justificante
  // del cliente (DS_MERCHANT_MERCHANTNAME, máx. 25). Vacío = el que tenga
  // BBVA en el contrato.
  REDSYS_MERCHANT_NAME: z.string().max(25).optional(),
  // Fase 1E — alertas y resumen de las 9:00 por Telegram al dueño. Sin las
  // dos, la bandeja de incidencias funciona igual y no se envía nada.
  // TELEGRAM_BOT_TOKEN: el que da @BotFather. TELEGRAM_CHAT_ID: el chat (o
  // grupo) del dueño con el bot.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  // Solo a través de Cloudflare: secreto que Cloudflare añade como cabecera
  // X-Origin-Auth (regla de transformación). Sin él, el servidor acepta
  // también peticiones directas a su IP. Ver docs/PUESTA-EN-MARCHA.md.
  ORIGIN_AUTH_SECRET: z.string().min(24).optional(),
  // Copias de seguridad: Dokploy las sube a un S3 (R2, Backblaze…); con esto
  // el API mira la fecha de la última y avisa si pasa más de un día sin
  // copias. Basta una clave de solo lectura. Ver docs/BACKUPS.md.
  BACKUP_S3_ENDPOINT: z.string().url().optional(),
  BACKUP_S3_REGION: z.string().optional(),
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_PREFIX: z.string().optional(),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(24 * 14).optional(),
  // Peanpe legacy URL var (no se usa con el adapter rehecho — mantener para
  // compat con env existentes). El adapter usa PEANPE_API_BASE_URL.
  PEANPE_API_URL: z.string().url(),
  PEANPE_WEBHOOK_SECRET: z.string().min(8),
  // Peanpe API v2.0 oficial (doc).
  //   - PEANPE_API_BASE_URL: base sin /api (default http://peanpe.com)
  //   - PEANPE_API_KEY: clave en HEXADECIMAL provista por Peanpe (la convertimos
  //     a bytes raw para hacer HMAC-SHA256 según su doc).
  //   - PEANPE_ACCOUNT_ID: identificador_cuenta_peanpe (número entero).
  //   - PEANPE_WEBHOOK_URL: URL pblica de NightPay configurada en su panel
  //     como "Webservice Comunicación". Default localhost en dev.
  //   - PEANPE_THANKYOU_URL: URL pblica donde el cliente aterriza tras pagar.
  PEANPE_API_BASE_URL: z.string().url().default('http://peanpe.com'),
  PEANPE_API_KEY: z.string().optional(),
  PEANPE_ACCOUNT_ID: z.string().optional(),
  PEANPE_WEBHOOK_URL: z.string().url().optional(),
  PEANPE_THANKYOU_URL: z.string().url().optional(),
  // CORS_ORIGINS — CSV de las direcciones exactas de las apps del personal
  // (https://admin.paytomaxx.com,…). Obligatoria en producción: sin ella (o con
  // una errata) el API arranca sano pero nadie del personal puede entrar (CORS
  // y la cookie de sesión la usan). Vacía en dev. Ver corsOriginsProblem.
  CORS_ORIGINS: z.string().optional(),
  // Timeout (ms) para llamadas a pasarelas — abort signal.
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Email — opcional; si no esta, EmailService entra en modo NoOp y la URL
  // de invite se devuelve al admin para envio manual via WhatsApp.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  // Base URL del frontend operator donde aceptar la invitacion (set-password).
  // Ejemplo: http://localhost:4104 (dev) o https://operator.paytomaxx.com (prod).
  // Sin valor por defecto: ahora ConfigService ve los defaults y uno de
  // localhost mandaría las invitaciones de producción a localhost. Si falta,
  // operator-app-url.ts la deduce de NEXT_PUBLIC_API_URL (api. → operator.).
  OPERATOR_BASE_URL: z.string().url().optional(),
  // Direcciones públicas de las apps (enlaces y QR) y dominio de la llave de
  // Face ID. Se leen también de process.env; aquí quedan documentadas y, si
  // están mal escritas, se avisa al arrancar (no se tumba el arranque).
  NEXT_PUBLIC_OPERATOR_URL: z.string().optional(),
  // El panel (enlace de «Compartir» del detalle de un cobro). Sin ella, la del
  // API con «admin.» en vez de «api.» (money-map/admin-panel-url.ts).
  ADMIN_BASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_WEB_CLIENT_URL: z.string().optional(),
  PASSKEY_RP_ID: z.string().optional(),
  // Google Wallet: el cliente guarda su saldo en Google Wallet (Android) y el
  // pase se actualiza solo. Opcional: sin el emisor y la clave de la cuenta
  // de servicio el botón no sale y no corre nada. Lo mal escrito no impide
  // arrancar: se apaga y se avisa (config/google-wallet.ts, env-warnings.ts).
  // Ver docs/GOOGLE-WALLET.md.
  //   GOOGLE_WALLET_ISSUER_ID — "Issuer ID" de la Google Pay & Wallet Console.
  //   GOOGLE_WALLET_SERVICE_ACCOUNT_JSON — el JSON de la clave, tal cual; o
  //   GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64 — el mismo JSON en base64.
  //   GOOGLE_WALLET_CLASS_SUFFIX — nombre de la clase de los pases.
  GOOGLE_WALLET_ISSUER_ID: z.string().trim().optional(),
  GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64: z.string().optional(),
  GOOGLE_WALLET_CLASS_SUFFIX: z.string().trim().default(DEFAULT_GOOGLE_WALLET_CLASS_SUFFIX),
  // «Aviso en cada cobro» (Web Push): el móvil del cliente recibe un aviso en
  // cada cobro de su saldo o ficha, con «No he sido yo». Opcional: sin las
  // tres, apagado (la página no lo ofrece). Lo mal escrito no impide arrancar:
  // se apaga y se avisa (config/web-push.ts, env-warnings.ts). Se generan con
  // `npx web-push generate-vapid-keys`.
  //   WEB_PUSH_VAPID_PUBLIC_KEY  — clave pública (base64url).
  //   WEB_PUSH_VAPID_PRIVATE_KEY — clave privada (base64url): solo en el servidor.
  //   WEB_PUSH_SUBJECT           — contacto: mailto:correo o https://.
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().trim().optional(),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().trim().optional(),
  WEB_PUSH_SUBJECT: z.string().trim().optional(),
  // Phase 1A — API keys de blockchain explorers (opcionales, free tier sirve).
  TRONSCAN_API_KEY: z.string().optional(),
  BSCSCAN_API_KEY: z.string().optional(),
  POLYGONSCAN_API_KEY: z.string().optional(),
  HELIUS_API_KEY: z.string().optional(),
  // Phase 1C — Viva.com SoftPOS (opcional, si no esta la integracion queda dormida).
  VIVA_API_KEY: z.string().optional(),
  VIVA_MERCHANT_ID: z.string().optional(),
  VIVA_WEBHOOK_SECRET: z.string().optional(),
  // Phase 1C — base URL Viva (sandbox vs prod).
  VIVA_BASE_URL: z.string().url().default('https://demo-api.vivapayments.com'),
  // Track B — Paytef Payment LINK API (https://api.paytef.es/gcf).
  // Si no está PAYTEF_API_TOKEN, el adapter queda dormido (gateway desactivado).
  // El token se obtiene en my.paytef.es → API de Payment LINK → "Habilitar API".
  PAYTEF_API_URL: z.string().url().default('https://api.paytef.es/gcf'),
  // Token de acceso sin el prefijo "PAYTEF-TOKEN " (el adapter lo añade).
  // Si lo pegas con prefijo, el adapter lo limpia.
  PAYTEF_API_TOKEN: z.string().optional(),
  // Secret compartido para validar webhooks Paytef (set en notifyResultURL).
  // Si Paytef firma webhooks con su propio esquema, este secret se usa para
  // generar la URL secreta del webhook (e.g. /v1/webhooks/paytef/<secret>).
  // Debería tener >= 32 caracteres (`openssl rand -hex 32`): si es más corto
  // se avisa al arrancar (no se falla, para no dejar sin servicio).
  PAYTEF_WEBHOOK_SECRET: z.string().optional(),
  // URL pública de NightPay para webhooks Paytef (configurada en notifyResultURL).
  // Ejemplo: https://api.paytomaxx.com/v1/webhooks/paytef
  PAYTEF_WEBHOOK_URL: z.string().url().optional(),
  // URL pública del frontend cliente para redirect tras pago (return URL).
  // Si vacío, Paytef usa su pantalla de "pago completado" por defecto.
  PAYTEF_RETURN_URL: z.string().url().optional(),
  // companyID y branchID del comercio en Paytef.
  // Obtenerlos vía GET /payment-link/getBranches con tu token.
  // Para la cuenta "Rapido Sin Riesgos": companyID=76861, branches RSR5..RSR12.
  PAYTEF_COMPANY_ID: z.coerce.number().int().optional(),
  PAYTEF_BRANCH_ID: z.coerce.number().int().optional(),
  // Sandbox de Paytef: "true" o "false" (otro valor se ignora, con aviso).
  // Sin definir: en producción modo real, en desarrollo sandbox.
  PAYTEF_FORCE_TEST: z.string().optional(),
  // Días que vale la credencial del datáfono PAX (sin definir: no caduca).
  // Antes de activarlo, rotar las credenciales con /v1/pos-device/rotate.
  POS_DEVICE_TOKEN_MAX_AGE_DAYS: z.string().optional(),
  // Observability — Sentry (opcional, si no está el SDK no se inicializa).
  SENTRY_DSN: z.string().url().optional(),
  // Inyectado por CI / Docker label — útil para tagging de releases en Sentry.
  GIT_SHA: z.string().optional(),
  // Marca del despliegue que enseña /v1/health (campo `build`).
  BUILD_MARKER: z.string().optional(),

  // URL pública de la API — usada por adapters Redsys/Wipay para construir
  // MERCHANTURL del webhook. Si vacía o localhost en prod, los webhooks de
  // la pasarela jamás llegarán (Redsys POSTea a localhost y nadie responde).
  NEXT_PUBLIC_API_URL: z.string().url().optional(),

  // Endpoints /v1/debug/* — exponen estado interno (last payments, last
  // webhooks, config metadata). Útiles para diagnosticar sin acceso a terminal
  // pero NO deben estar abiertos en producción permanentemente:
  //   - true  → debug endpoints responden normalmente
  //   - false → 403 Forbidden (default)
  // En Dokploy: flip a "true" cuando necesites diagnosticar, vuelve a "false"
  // cuando termines. Si lo dejas "true" expones datos de payment a internet.
  DEBUG_ENDPOINTS_ENABLED: z
    .union([
      z.boolean(),
      z.string().transform((s) => s === 'true' || s === '1'),
    ])
    .default(false),

  // GET /v1/metrics en producción solo con `Authorization: Bearer
  // <METRICS_TOKEN>` (también el scrape interno de la red Docker). Sin
  // definir → métricas cerradas (aviso al arrancar).
  METRICS_TOKEN: z.string().min(24, 'METRICS_TOKEN >= 24 chars').optional(),

  // Consultas a un modelo por local sin local y sin asSystem/acrossVenues
  // (posible fallo de aislamiento): 'log' = se registran (log + métrica
  // nightpay_tenant_unscoped_queries_total) y siguen; 'throw' = se cortan.
  // Pasar a 'throw' cuando la métrica lleve días en 0.
  TENANCY_UNSCOPED_QUERIES: z.enum(['log', 'throw']).default('log'),

  // Tiempo real: payment:subscribe sin sesión (apps antiguas en caché) solo
  // hasta esta fecha; luego se pide iniciar sesión otra vez. Sin definir:
  // 2026-11-17T12:00:00+01:00 (martes a mediodía). Fecha ISO con zona para cambiarla, u "off"
  // para apagarla ya. Antes de la fecha, la métrica
  // nightpay_ws_legacy_subscribes_total debería estar en 0. Ver
  // config/realtime-legacy.ts.
  REALTIME_LEGACY_SUBSCRIBE_UNTIL: z
    .string()
    .trim()
    .refine(isValidLegacySubscribeUntil, LEGACY_SUBSCRIBE_UNTIL_HINT)
    .optional(),

  // Sesión del personal: el refresh token en el cuerpo (apps antiguas en
  // caché) solo hasta esta fecha; las nuevas lo llevan en una cookie HttpOnly.
  // Sin definir: 2026-12-01T12:00:00+01:00 (martes a mediodía). Fecha ISO con zona para cambiarla,
  // u "off" para cerrarla ya. Antes, nightpay_auth_body_refresh_total
  // {client="legacy"} debería estar quieta. Ver config/auth-body-refresh.ts.
  AUTH_BODY_REFRESH_UNTIL: z
    .string()
    .trim()
    .refine(isValidAuthBodyRefreshUntil, AUTH_BODY_REFRESH_UNTIL_HINT)
    .optional(),

  // Días que una comisión de la chica queda "en espera" antes de poder
  // pagársela (cubre devoluciones tempranas y que el banco aún no abonó).
  PAYOUT_HOLD_DAYS: z.coerce.number().int().min(0).max(60).default(7),

  // Comisión del banco sobre lo cobrado con tarjeta (bps: 45 = 0,45 %), para el
  // mapa del dinero. Sin definir, el mapa no la calcula (sale en el extracto de BBVA).
  BANK_CARD_FEE_BPS: z.coerce.number().int().min(0).max(1000).optional(),

  // «Saldo al momento» (wallet-events/): la conexión que escucha los avisos de
  // Postgres (LISTEN). Sin definir, DATABASE_URL. Hace falta otra solo si
  // DATABASE_URL pasa por un PgBouncer en modo transacción (ahí LISTEN no va):
  // entonces, una directa a Postgres. Con la base caída, sin URL o apagado
  // (NIGHTPAY_DISABLE_WALLET_EVENTS=1), las páginas siguen con su sondeo.
  WALLET_EVENTS_DATABASE_URL: z.string().url().optional(),

  // Apagar tareas programadas (solo desarrollo/pruebas): "1" = apagada. Los
  // servicios las leen de process.env; aquí quedan documentadas y, en
  // producción, el arranque avisa de cada una (env-warnings.ts, DISABLE_FLAGS).
  NIGHTPAY_DISABLE_ALERTS: z.string().optional(),
  NIGHTPAY_DISABLE_NIGHT_AUTOCLOSE: z.string().optional(),
  NIGHTPAY_DISABLE_GOOGLE_WALLET_SYNC: z.string().optional(),
  NIGHTPAY_DISABLE_WEBHOOK_SWEEP: z.string().optional(),
  NIGHTPAY_DISABLE_REFUND_SWEEP: z.string().optional(),
  NIGHTPAY_DISABLE_OXIOPAY_SETTLEMENTS: z.string().optional(),
  NIGHTPAY_DISABLE_WALLET_EVENTS: z.string().optional(),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;
  // NEXT_PUBLIC_API_URL no puede ser localhost (los webhooks de la pasarela
  // quedarían rotos).
  if (!isPublicUrl(env.NEXT_PUBLIC_API_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NEXT_PUBLIC_API_URL'],
      message:
        'NEXT_PUBLIC_API_URL es obligatorio en production y no puede apuntar a localhost. Configúralo a https://api.paytomaxx.com (o tu dominio) para que Redsys/Wipay puedan entregar webhooks. En local arranca con `pnpm dev` (NODE_ENV=development).',
    });
  }
  const cors = corsOriginsProblem(env.CORS_ORIGINS);
  if (cors) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGINS'], message: cors });
  }
  // Los secretos de ejemplo de .env.example no valen en producción.
  for (const key of GUARDED_SECRETS) {
    if (isPlaceholderSecret(key, env[key])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} es el valor de ejemplo de .env.example: genera uno propio (openssl rand -hex 32).`,
      });
    }
  }
});

export type Env = z.infer<typeof EnvSchema>;

const CORS_ORIGINS_EXAMPLE = 'https://admin.paytomaxx.com,https://operator.paytomaxx.com,https://tpv.paytomaxx.com';

/**
 * Producción: CORS_ORIGINS tiene que traer al menos un origen y cada uno ser
 * exactamente `https://dominio` (sin ruta ni barra final: el navegador manda
 * el Origin así y se compara tal cual). null = vale.
 */
export function corsOriginsProblem(raw: string | undefined): string | null {
  const origins = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (origins.length === 0) {
    return `CORS_ORIGINS es obligatoria en production: las direcciones de las apps del personal separadas por comas (p. ej. ${CORS_ORIGINS_EXAMPLE}). Sin ella nadie puede entrar.`;
  }
  const bad = origins.filter((o) => !isExactOrigin(o));
  return bad.length === 0
    ? null
    : `CORS_ORIGINS no vale (${bad.join(', ')}): cada una https://dominio, sin ruta ni barra final, separadas por comas (p. ej. ${CORS_ORIGINS_EXAMPLE}).`;
}

function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

function isPublicUrl(url: string | undefined): boolean {
  return Boolean(url) && !url!.includes('localhost') && !url!.includes('127.0.0.1');
}

function isPlaceholderSecret(key: GuardedSecret, value: string): boolean {
  const lower = value.toLowerCase();
  return value === DEV_PLACEHOLDER_SECRETS[key] || EXAMPLE_SECRET_MARKERS.some((marker) => lower.includes(marker));
}

/** Entorno inválido: lleva los problemas por variable (sin valores). */
export class InvalidEnvError extends Error {
  readonly issues: Readonly<Record<string, string[] | undefined>>;

  constructor(issues: Record<string, string[] | undefined>) {
    const detail = Object.entries(issues)
      .map(([key, messages]) => `${key}: ${(messages ?? []).join('; ')}`)
      .join(' | ');
    super(`Entorno inválido — ${detail}`);
    this.name = 'InvalidEnvError';
    this.issues = issues;
  }
}

/** Valida y convierte (números, booleanos, valores por defecto). Lanza InvalidEnvError. */
export function parseEnv(raw: Readonly<Record<string, unknown>>): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidEnvError(parsed.error.flatten().fieldErrors);
  return parsed.data;
}

/**
 * Para ConfigModule.forRoot({ validate }): así `config.get()` devuelve los
 * valores ya convertidos y con sus valores por defecto (antes devolvía el
 * texto crudo de process.env y no veía ningún default).
 */
export function validateConfig(raw: Readonly<Record<string, unknown>>): Env {
  return parseEnv(raw);
}

/** Opciones de ConfigModule.forRoot (app.module): mismo esquema que main.ts. */
export function configModuleOptions(): ConfigModuleOptions {
  return {
    isGlobal: true,
    cache: true,
    envFilePath: ['.env.local', '.env'],
    validate: validateConfig,
  };
}

/** Entorno del proceso para main.ts; si no vale, explica por qué y sale. */
export function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (err) {
    const issues = err instanceof InvalidEnvError ? err.issues : { env: [(err as Error).message] };
    new Logger('Env').error(`Entorno inválido: ${JSON.stringify(issues)}`);
    process.exit(1);
  }
}
