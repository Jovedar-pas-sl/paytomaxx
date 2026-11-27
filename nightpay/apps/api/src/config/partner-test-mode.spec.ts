import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { InvalidEnvError, parseEnv } from './env';
import { PARTNER_TEST_MODE_MESSAGES, testHelpersOn } from './partner-test-mode';
import { partnerTestHelpersImports } from '../modules/partner/test-helpers/partner-test-helpers.module';

/**
 * El freno de arranque de la demo (PR 8 A1): las ayudas de prueba solo con la
 * API en `test`, y el modo prueba sin dinero real ni, en producción, la
 * dirección, la base o el Redis de producción. Cada fallo con su variable en
 * `path` y nunca su valor.
 */

/** Un entorno de producción válido (como el de env.spec.ts). */
const PROD: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@nightpay-postgres:5432/db',
  REDIS_URL: 'redis://nightpay-redis:6379',
  JWT_SECRET: 'jwt-de-prueba-0123456789abcdef0123456789',
  COOKIE_SECRET: 'cookie-de-prueba-0123456789abcdef012345',
  ENCRYPTION_KEK: 'kek-de-prueba-0123456789abcdef0123456789',
  PEANPE_API_URL: 'https://peanpe.invalid/api',
  PEANPE_WEBHOOK_SECRET: 'secreto-peanpe',
  NEXT_PUBLIC_API_URL: 'https://api.paytomaxx.com',
  CORS_ORIGINS: 'https://admin.paytomaxx.com,https://operator.paytomaxx.com',
};

const PROD_ENV = PROD;

/** La demo limpia (fase H del despliegue). */
const DEMO: Record<string, string> = {
  ...PROD,
  DATABASE_URL: 'postgresql://u:p@nightpay-demo-postgres:5432/db',
  REDIS_URL: 'redis://nightpay-demo-redis:6379',
  NEXT_PUBLIC_API_URL: 'https://demo-api.paytomaxx.com',
  CORS_ORIGINS: 'https://demo-admin.paytomaxx.com,https://demo-operator.paytomaxx.com',
  REDSYS_API_URL: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  PARTNER_API_ENABLED: 'true',
  PARTNER_API_MODE: 'test',
  PARTNER_TEST_HELPERS: '1',
};

/** Los problemas por variable, o null si arranca. */
function issues(raw: Record<string, string | undefined>): Record<string, string[] | undefined> | null {
  const clean = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  try {
    parseEnv(clean);
    return null;
  } catch (err) {
    if (err instanceof InvalidEnvError) return err.issues as Record<string, string[] | undefined>;
    throw err;
  }
}

/** Falla solo por `path`, con `message` y sin el valor de la variable. */
function expectOnly(raw: Record<string, string | undefined>, path: string, message: string) {
  const found = issues(raw);
  expect(found, `${path} debería fallar`).not.toBeNull();
  expect(Object.keys(found!)).toEqual([path]);
  expect(found![path]).toContain(message);
  // Los valores cortos («1», «true») salen por fuerza en cualquier texto: solo se miran los largos.
  const value = (raw[path] ?? '').trim().length > 4 ? raw[path] : undefined;
  if (value) expect(JSON.stringify(found)).not.toContain(value);
  // Tampoco en el texto del error entero.
  try {
    parseEnv(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)));
  } catch (err) {
    if (value) expect((err as Error).message).not.toContain(value);
  }
}

describe('freno de la demo: la demo limpia', () => {
  it('arranca (producción, API en test, ayudas, Redsys del sandbox, hosts de la demo)', () => {
    expect(issues(DEMO)).toBeNull();
  });

  it('valen demo-api.x.com, api.demo.x.com y un host nightpay-demo-postgres-x1y2', () => {
    expect(issues({ ...DEMO, NEXT_PUBLIC_API_URL: 'https://demo-api.x.com' })).toBeNull();
    expect(issues({ ...DEMO, NEXT_PUBLIC_API_URL: 'https://api.demo.x.com' })).toBeNull();
    expect(issues({ ...DEMO, DATABASE_URL: 'postgresql://u:p@nightpay-demo-postgres-x1y2:5432/db' })).toBeNull();
    expect(issues({ ...DEMO, WALLET_EVENTS_DATABASE_URL: 'postgresql://u:p@nightpay-demo-postgres-x1y2:5432/db' })).toBeNull();
  });

  it('la producción de siempre (live, sin ayudas) no cambia', () => {
    expect(issues({ ...PROD, PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'live', ORIGIN_AUTH_SECRET: 'x'.repeat(40) })).toBeNull();
    expect(issues(PROD)).toBeNull();
  });
});

describe('freno de la demo: las ayudas solo con la API en test', () => {
  it('con PARTNER_TEST_HELPERS=1 en live, apagada o sin modo, en cualquier NODE_ENV: no arranca', () => {
    const msg = PARTNER_TEST_MODE_MESSAGES.helpersOutsideDemo;
    // Base y Redis locales: aquí solo se mira el modo (los hosts, en su bloque).
    const PROD = { ...PROD_ENV, DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://localhost:6379' };
    expectOnly({ ...PROD, PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'live', ORIGIN_AUTH_SECRET: 'x'.repeat(40), PARTNER_TEST_HELPERS: '1' }, 'PARTNER_TEST_HELPERS', msg);
    expectOnly({ ...PROD, PARTNER_TEST_HELPERS: '1' }, 'PARTNER_TEST_HELPERS', msg);
    for (const NODE_ENV of ['development', 'test']) {
      expectOnly({ ...PROD, NODE_ENV, PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'live', PARTNER_TEST_HELPERS: '1' }, 'PARTNER_TEST_HELPERS', msg);
      expectOnly({ ...PROD, NODE_ENV, PARTNER_TEST_HELPERS: ' 1 ' }, 'PARTNER_TEST_HELPERS', msg);
    }
    expect(msg).toBe('Las ayudas de prueba (PARTNER_TEST_HELPERS=1) solo van en la demo: PARTNER_API_ENABLED=true y PARTNER_API_MODE=test.');
  });

  it('`0`, `true` o vacía no encienden las ayudas', () => {
    for (const v of ['0', 'true', 'yes', '', ' ', 'on']) {
      expect(testHelpersOn({ PARTNER_TEST_HELPERS: v }), v).toBe(false);
      expect(issues({ ...PROD, PARTNER_TEST_HELPERS: v }), v).toBeNull();
    }
    expect(testHelpersOn({ PARTNER_TEST_HELPERS: ' 1 ' })).toBe(true);
    expect(testHelpersOn({})).toBe(false);
  });

  it('partnerTestHelpersImports: el módulo solo con las ayudas y la API en test', () => {
    expect(partnerTestHelpersImports({ PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'live', PARTNER_TEST_HELPERS: '1' })).toEqual([]);
    expect(partnerTestHelpersImports({ PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'test' })).toEqual([]);
    expect(partnerTestHelpersImports({ PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'test', PARTNER_TEST_HELPERS: 'true' })).toEqual([]);
    expect(partnerTestHelpersImports({ PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'test', PARTNER_TEST_HELPERS: '1' })).toHaveLength(1);
  });
});

describe('freno de la demo: sin dinero real a mano', () => {
  it('Redsys que no es el sandbox exacto (también sis-t.redsys.es.example.com): no arranca', () => {
    const msg = PARTNER_TEST_MODE_MESSAGES.redsys;
    expectOnly({ ...DEMO, REDSYS_API_URL: 'https://sis.redsys.es/sis/realizarPago' }, 'REDSYS_API_URL', msg);
    expectOnly({ ...DEMO, REDSYS_API_URL: 'https://sis-t.redsys.es.example.com/sis/realizarPago' }, 'REDSYS_API_URL', msg);
    expectOnly({ ...DEMO, REDSYS_API_URL: 'https://bbvaempresas.redsys.es/sis/realizarPago' }, 'REDSYS_API_URL', msg);
    expect(msg).toBe('En modo prueba REDSYS_API_URL es el sandbox de Redsys (sis-t.redsys.es).');
  });

  it('con las ayudas en development, Redsys real tampoco', () => {
    const dev = { ...DEMO, NODE_ENV: 'development', REDSYS_API_URL: 'https://sis.redsys.es/sis/realizarPago' };
    expectOnly(dev, 'REDSYS_API_URL', PARTNER_TEST_MODE_MESSAGES.redsys);
  });

  it('«Pagar con bitcoin» encendido: no arranca', () => {
    expectOnly({ ...DEMO, BTCPAY_ENABLED: 'true' }, 'BTCPAY_ENABLED', 'En modo prueba «Pagar con bitcoin» va apagado.');
    expectOnly({ ...DEMO, NODE_ENV: 'development', BTCPAY_ENABLED: '1' }, 'BTCPAY_ENABLED', 'En modo prueba «Pagar con bitcoin» va apagado.');
  });

  it.each(['PAYTEF_API_TOKEN', 'PEANPE_API_KEY', 'VIVA_API_KEY', 'WIPAY_MERCHANT_ID'])('%s puesta: no arranca, y el mensaje la nombra', (name) => {
    const value = name === 'WIPAY_MERCHANT_ID' ? '999008881' : `credencial-secreta-${name.toLowerCase()}`;
    expectOnly({ ...DEMO, [name]: value }, name, `En modo prueba no van credenciales de cobro: quita ${name}.`);
    expectOnly({ ...DEMO, NODE_ENV: 'development', [name]: value }, name, `En modo prueba no van credenciales de cobro: quita ${name}.`);
  });

  it('la API en test en producción sin ayudas también lo mira', () => {
    expectOnly({ ...DEMO, PARTNER_TEST_HELPERS: undefined, BTCPAY_ENABLED: 'true' }, 'BTCPAY_ENABLED', PARTNER_TEST_MODE_MESSAGES.btcpay);
  });

  it('en development sin ayudas, la API en test no se frena (los arneses locales)', () => {
    expect(issues({ ...PROD, NODE_ENV: 'development', PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'test', PEANPE_API_KEY: 'abc' })).toBeNull();
  });
});

describe('freno de la demo: en producción, ni la dirección ni la base ni el Redis de producción', () => {
  it('NEXT_PUBLIC_API_URL sin etiqueta demo…: no arranca', () => {
    const msg = 'En modo prueba la API va en una dirección de demo, nunca en la de producción.';
    expectOnly({ ...DEMO, NEXT_PUBLIC_API_URL: 'https://api.paytomaxx.com' }, 'NEXT_PUBLIC_API_URL', msg);
    expectOnly({ ...DEMO, NEXT_PUBLIC_API_URL: 'https://api.paytomaxx-demo.com' }, 'NEXT_PUBLIC_API_URL', msg);
  });

  it.each(['DATABASE_URL', 'REDIS_URL', 'WALLET_EVENTS_DATABASE_URL'])('%s de producción (nightpay-postgres): no arranca', (name) => {
    const value = name === 'REDIS_URL' ? 'redis://nightpay-redis:6379' : 'postgresql://u:clave-real@nightpay-postgres:5432/db';
    expectOnly({ ...DEMO, [name]: value }, name, 'En modo prueba la base y Redis son los de la demo (nightpay-demo-…), nunca los de producción.');
  });

  it('en development con las ayudas, la base y la dirección locales valen (solo el dinero real se frena)', () => {
    expect(issues({ ...DEMO, NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://localhost:6379', NEXT_PUBLIC_API_URL: 'http://localhost:4100' })).toBeNull();
  });
});

describe('freno de la demo: con las ayudas, en cualquier NODE_ENV, ni túnel a producción ni sus secretos', () => {
  const DEV = { ...DEMO, NODE_ENV: 'development', NEXT_PUBLIC_API_URL: 'http://localhost:4100' };

  it.each(['DATABASE_URL', 'REDIS_URL', 'WALLET_EVENTS_DATABASE_URL'])('%s por un túnel (host que no es local ni de la demo): no arranca', (name) => {
    const value = name === 'REDIS_URL' ? 'redis://10.0.0.7:6379' : 'postgresql://u:clave-real@tunel.interno:5432/db';
    expectOnly({ ...DEV, [name]: value }, name, PARTNER_TEST_MODE_MESSAGES.helperStores);
    expectOnly({ ...DEMO, NODE_ENV: 'test', [name]: value }, name, PARTNER_TEST_MODE_MESSAGES.helperStores);
  });

  it('localhost, 127.0.0.1 y un host con «demo» valen', () => {
    expect(issues({ ...DEV, DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db', REDIS_URL: 'redis://localhost:6379' })).toBeNull();
    expect(issues({ ...DEV, DATABASE_URL: 'postgresql://u:p@nightpay-demo-postgres:5432/db', REDIS_URL: 'redis://nightpay-demo-redis:6379' })).toBeNull();
  });

  it('sin las ayudas, el entorno local de siempre no cambia', () => {
    expect(issues({ ...PROD, NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@tunel.interno:5432/db', TELEGRAM_BOT_TOKEN: '123456:ABCDEF' })).toBeNull();
  });

  it.each([
    ['TELEGRAM_BOT_TOKEN', '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra'],
    ['REDSYS_SECRET_KEY', 'sq7HjrUOBfKmC576ILgskD5srU870gJ7'],
  ])('con %s puesto: no arranca (ni en producción ni en development)', (name, value) => {
    expectOnly({ ...DEV, [name]: value }, name, PARTNER_TEST_MODE_MESSAGES.secret(name));
    expectOnly({ ...DEMO, [name]: value }, name, PARTNER_TEST_MODE_MESSAGES.secret(name));
  });
});

describe('la semilla de la demo pasa por el mismo freno', () => {
  it('con la base por un túnel: sale con 1 antes de abrir la base', () => {
    const env = {
      ...DEMO,
      NODE_ENV: 'development',
      NEXT_PUBLIC_API_URL: 'http://localhost:4100',
      DATABASE_URL: 'postgresql://u:clave-real@tunel.interno:5432/db',
      PATH: process.env.PATH ?? '',
    };
    const api = resolve(__dirname, '../..');
    const out = spawnSync(resolve(api, 'node_modules/.bin/tsx'), ['scripts/partner-demo-seed.ts'], { cwd: api, env, encoding: 'utf8', timeout: 60_000 });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('entorno inválido (DATABASE_URL)');
    expect(out.stderr).toContain(PARTNER_TEST_MODE_MESSAGES.helperStores);
    expect(out.stderr + out.stdout).not.toContain('clave-real');
  }, 60_000);
});
