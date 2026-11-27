import { z } from 'zod';

/**
 * El freno de arranque de la demo (PR 8 parte A). Las ayudas de prueba
 * (`POST /test/live-codes`, `POST /test/fixtures/reset`) crean códigos y
 * saldos de mentira: solo valen en la demo, con la API en `test`
 * (PARTNER_API_ENABLED=true y PARTNER_API_MODE=test) y PARTNER_TEST_HELPERS=1.
 * Y el modo prueba no arranca con dinero real a mano ni, en producción, con la
 * base, el Redis o la dirección de producción. Lo llama el `superRefine` de
 * env.ts: cada fallo lleva en `path` la variable, nunca su valor. No lee la
 * base: sustituye la comprobación de tiendas BTCPay del diseño (§3.7, S8) por
 * BTCPAY_ENABLED apagado, la ENCRYPTION_KEK propia de la demo y la puerta 8.
 */

type RawEnv = Readonly<Record<string, string | undefined>>;

/** PARTNER_TEST_HELPERS=1 (recortada). `0`, `true` o cualquier otra cosa no la encienden. */
export function testHelpersOn(env: Readonly<{ PARTNER_TEST_HELPERS?: string | undefined }> = process.env as RawEnv): boolean {
  return env.PARTNER_TEST_HELPERS?.trim() === '1';
}

/** Lo que mira el freno, ya convertido por EnvSchema. */
export interface PartnerTestModeEnv {
  NODE_ENV: string;
  PARTNER_API_ENABLED: boolean;
  PARTNER_API_MODE?: string | undefined;
  PARTNER_TEST_HELPERS?: string | undefined;
  REDSYS_API_URL: string;
  BTCPAY_ENABLED: boolean;
  PAYTEF_API_TOKEN?: string | undefined;
  PEANPE_API_KEY?: string | undefined;
  VIVA_API_KEY?: string | undefined;
  WIPAY_MERCHANT_ID?: string | undefined;
  NEXT_PUBLIC_API_URL?: string | undefined;
  DATABASE_URL: string;
  REDIS_URL: string;
  WALLET_EVENTS_DATABASE_URL?: string | undefined;
}

/** El host del sandbox de Redsys: el adaptador elige sus direcciones de prueba por él. */
const REDSYS_SANDBOX_HOST = 'sis-t.redsys.es';
const PAYMENT_CREDENTIALS = ['PAYTEF_API_TOKEN', 'PEANPE_API_KEY', 'VIVA_API_KEY', 'WIPAY_MERCHANT_ID'] as const;
const DEMO_STORES = ['DATABASE_URL', 'REDIS_URL', 'WALLET_EVENTS_DATABASE_URL'] as const;

export const PARTNER_TEST_MODE_MESSAGES = {
  helpersOutsideDemo:
    'Las ayudas de prueba (PARTNER_TEST_HELPERS=1) solo van en la demo: PARTNER_API_ENABLED=true y PARTNER_API_MODE=test.',
  redsys: 'En modo prueba REDSYS_API_URL es el sandbox de Redsys (sis-t.redsys.es).',
  btcpay: 'En modo prueba «Pagar con bitcoin» va apagado.',
  credential: (name: string) => `En modo prueba no van credenciales de cobro: quita ${name}.`,
  apiUrl: 'En modo prueba la API va en una dirección de demo, nunca en la de producción.',
  stores: 'En modo prueba la base y Redis son los de la demo (nightpay-demo-…), nunca los de producción.',
} as const;

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Alguna etiqueta del host empieza por `demo` (`demo-api.…`, `api.demo.…`). */
function isDemoApiHost(host: string | null): boolean {
  return host !== null && host.split('.').some((label) => label.startsWith('demo'));
}

export interface PartnerTestModeIssue {
  path: string;
  message: string;
}

/** Los fallos del freno (vacío = vale). Pura. */
export function partnerTestModeIssues(env: PartnerTestModeEnv): PartnerTestModeIssue[] {
  const issues: PartnerTestModeIssue[] = [];
  const apiTest = env.PARTNER_API_ENABLED === true && env.PARTNER_API_MODE === 'test';
  const helpers = testHelpersOn(env);
  const production = env.NODE_ENV === 'production';

  if (helpers && !apiTest) issues.push({ path: 'PARTNER_TEST_HELPERS', message: PARTNER_TEST_MODE_MESSAGES.helpersOutsideDemo });

  // Sin dinero real a mano: la API en `test` en producción, o con las ayudas en cualquier NODE_ENV.
  if ((apiTest && production) || helpers) {
    if (hostOf(env.REDSYS_API_URL) !== REDSYS_SANDBOX_HOST) issues.push({ path: 'REDSYS_API_URL', message: PARTNER_TEST_MODE_MESSAGES.redsys });
    if (env.BTCPAY_ENABLED) issues.push({ path: 'BTCPAY_ENABLED', message: PARTNER_TEST_MODE_MESSAGES.btcpay });
    for (const name of PAYMENT_CREDENTIALS) {
      if ((env[name] ?? '').trim() !== '') issues.push({ path: name, message: PARTNER_TEST_MODE_MESSAGES.credential(name) });
    }
  }

  // Solo en producción: la dirección, la base y Redis, los de la demo.
  if (apiTest && production) {
    if (!isDemoApiHost(hostOf(env.NEXT_PUBLIC_API_URL))) issues.push({ path: 'NEXT_PUBLIC_API_URL', message: PARTNER_TEST_MODE_MESSAGES.apiUrl });
    for (const name of DEMO_STORES) {
      if (name === 'WALLET_EVENTS_DATABASE_URL' && !env[name]) continue;
      if (!(hostOf(env[name]) ?? '').includes('demo')) issues.push({ path: name, message: PARTNER_TEST_MODE_MESSAGES.stores });
    }
  }
  return issues;
}

/** Desde el `superRefine` de env.ts. */
export function checkPartnerTestMode(env: PartnerTestModeEnv, ctx: z.RefinementCtx): void {
  for (const issue of partnerTestModeIssues(env)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
  }
}

/**
 * El módulo de las ayudas (lo esparcen solo app.module.ts y
 * test/support/socios.ts): existe solo con las ayudas encendidas y la API en
 * `test`. Lo lee de process.env al cargar el módulo (main.ts carga antes el
 * entorno y el freno no deja arrancar con las ayudas fuera de la demo).
 */
export function partnerTestHelpersEnabled(env: RawEnv = process.env as RawEnv): boolean {
  return testHelpersOn(env) && env.PARTNER_API_MODE?.trim() === 'test';
}
