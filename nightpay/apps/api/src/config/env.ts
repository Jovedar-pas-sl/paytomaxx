import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
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
  // CORS_ORIGINS — CSV de origins permitidos en produccion. Vacio en dev.
  CORS_ORIGINS: z.string().optional(),
  // Timeout (ms) para llamadas a pasarelas — abort signal.
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Email — opcional; si no esta, EmailService entra en modo NoOp y la URL
  // de invite se devuelve al admin para envio manual via WhatsApp.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  // Base URL del frontend operator donde aceptar la invitacion (set-password).
  // Ejemplo: http://localhost:4104 (dev) o https://operator.paytomaxx.com (prod).
  OPERATOR_BASE_URL: z.string().url().default('http://localhost:4104'),
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
  // Observability — Sentry (opcional, si no está el SDK no se inicializa).
  SENTRY_DSN: z.string().url().optional(),
  // Inyectado por CI / Docker label — útil para tagging de releases en Sentry.
  GIT_SHA: z.string().optional(),

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

  // GET /v1/metrics desde internet (vía Cloudflare) solo con
  // `Authorization: Bearer <METRICS_TOKEN>`. El scrape interno de la red
  // Docker no lo necesita. Sin definir → métricas cerradas a internet.
  METRICS_TOKEN: z.string().min(24, 'METRICS_TOKEN >= 24 chars').optional(),

  // Días que una comisión de la chica queda "en espera" antes de poder
  // pagársela (cubre devoluciones tempranas y que el banco aún no abonó).
  PAYOUT_HOLD_DAYS: z.coerce.number().int().min(0).max(60).default(7),
})
  // Cross-field validation: si NODE_ENV=production, NEXT_PUBLIC_API_URL no
  // puede ser localhost (los webhooks de la pasarela quedarían rotos).
  .refine(
    (env) => {
      if (env.NODE_ENV !== 'production') return true;
      const url = env.NEXT_PUBLIC_API_URL;
      if (!url) return false;
      return !url.includes('localhost') && !url.includes('127.0.0.1');
    },
    {
      message:
        'NEXT_PUBLIC_API_URL es obligatorio en production y no puede apuntar a localhost. Configúralo a https://api.paytomaxx.com (o tu dominio) para que Redsys/Wipay puedan entregar webhooks.',
      path: ['NEXT_PUBLIC_API_URL'],
    },
  );

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment:');
    // eslint-disable-next-line no-console
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
