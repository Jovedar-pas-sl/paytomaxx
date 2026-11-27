import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEV_PLACEHOLDER_SECRETS,
  GUARDED_SECRETS,
  InvalidEnvError,
  corsOriginsProblem,
  parseEnv,
  validateConfig,
} from './env';
import { DISABLE_FLAGS, envWarnings } from './env-warnings';

/** Las variables con valor de nightpay/.env.example, tal cual. */
const EXAMPLE: Record<string, string> = Object.fromEntries(
  readFileSync(join(__dirname, '../../../../.env.example'), 'utf8')
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!.trim()]),
);

/** Lo mínimo para arrancar (valores de prueba, no los de .env.example). */
const BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'jwt-de-prueba-0123456789abcdef0123456789',
  COOKIE_SECRET: 'cookie-de-prueba-0123456789abcdef012345',
  ENCRYPTION_KEK: 'kek-de-prueba-0123456789abcdef0123456789',
  PEANPE_API_URL: 'http://localhost:4902',
  PEANPE_WEBHOOK_SECRET: 'secreto-peanpe',
};
const PROD: Record<string, string> = {
  ...BASE,
  NODE_ENV: 'production',
  NEXT_PUBLIC_API_URL: 'https://api.paytomaxx.com',
  CORS_ORIGINS: 'https://admin.paytomaxx.com,https://tpv.paytomaxx.com',
};

describe('entorno: NODE_ENV', () => {
  it('sin NODE_ENV se asume producción (lo seguro), y entonces exige la URL pública del API', () => {
    expect(() => parseEnv(BASE)).toThrow(InvalidEnvError);
    expect(() => parseEnv(BASE)).toThrow(/NEXT_PUBLIC_API_URL/);
    const env = parseEnv({ ...BASE, NEXT_PUBLIC_API_URL: 'https://api.paytomaxx.com', CORS_ORIGINS: PROD.CORS_ORIGINS! });
    expect(env.NODE_ENV).toBe('production');
  });

  it('en local hay que decirlo: NODE_ENV=development', () => {
    expect(parseEnv({ ...BASE, NODE_ENV: 'development' }).NODE_ENV).toBe('development');
  });
});

describe('entorno: CORS_ORIGINS obligatoria en producción', () => {
  it('sin ella (o vacía) el API no arranca y el error explica qué poner', () => {
    for (const value of [undefined, '', ' , ']) {
      const raw = { ...PROD, CORS_ORIGINS: value } as Record<string, unknown>;
      if (value === undefined) delete raw.CORS_ORIGINS;
      expect(() => parseEnv(raw)).toThrow(/CORS_ORIGINS es obligatoria en production/);
    }
  });

  it('cada una https://dominio, sin barra final ni ruta; con espacios alrededor, vale', () => {
    expect(corsOriginsProblem('https://admin.paytomaxx.com, https://tpv.paytomaxx.com')).toBeNull();
    expect(corsOriginsProblem('https://localhost:3001')).toBeNull();
    for (const bad of ['https://admin.paytomaxx.com/', 'admin.paytomaxx.com', 'http://admin.paytomaxx.com', 'https://a.es/panel']) {
      expect(corsOriginsProblem(`https://ok.paytomaxx.com,${bad}`)).toContain(bad);
    }
    expect(() => parseEnv({ ...PROD, CORS_ORIGINS: 'https://admin.paytomaxx.com/' })).toThrow(/sin ruta ni barra final/);
  });

  it('en local no hace falta', () => {
    const { CORS_ORIGINS: _cors, ...sinCors } = PROD;
    expect(parseEnv({ ...sinCors, NODE_ENV: 'development' }).CORS_ORIGINS).toBeUndefined();
  });
});

describe('entorno: NIGHTPAY_DISABLE_* en producción', () => {
  it('cada tarea apagada (=1) da su aviso al arrancar; ALERTS dice que también calla «Por aprobar»', () => {
    const flags = Object.keys(DISABLE_FLAGS);
    expect(flags).toEqual(
      expect.arrayContaining(['NIGHTPAY_DISABLE_WEBHOOK_SWEEP', 'NIGHTPAY_DISABLE_REFUND_SWEEP', 'NIGHTPAY_DISABLE_ALERTS']),
    );
    const all = Object.fromEntries(flags.map((k) => [k, '1']));
    const text = envWarnings(validateConfig({ ...PROD, ...all })).join('\n');
    for (const key of flags) expect(text).toContain(`${key}=1`);
    expect(text).toMatch(/NIGHTPAY_DISABLE_ALERTS=1.*Por aprobar/);
  });

  it('sin ellas, a 0, o en local: ningún aviso', () => {
    expect(envWarnings(validateConfig(PROD)).join('\n')).not.toMatch(/NIGHTPAY_DISABLE_/);
    expect(envWarnings(validateConfig({ ...PROD, NIGHTPAY_DISABLE_ALERTS: '0' })).join('\n')).not.toMatch(/NIGHTPAY_DISABLE_/);
    const dev = validateConfig({ ...PROD, NODE_ENV: 'development', NIGHTPAY_DISABLE_ALERTS: '1' });
    expect(envWarnings(dev).join('\n')).not.toMatch(/NIGHTPAY_DISABLE_/);
  });
});

describe('entorno: valores ya convertidos (lo que ve ConfigService)', () => {
  it('números y booleanos llegan como tales, con sus valores por defecto', () => {
    const env = validateConfig({ ...PROD, GATEWAY_TIMEOUT_MS: '7000', DEBUG_ENDPOINTS_ENABLED: 'true' });
    expect(env.GATEWAY_TIMEOUT_MS).toBe(7000);
    expect(env.DEBUG_ENDPOINTS_ENABLED).toBe(true);
    expect(env.PORT).toBe(4100);
    expect(env.PAYOUT_HOLD_DAYS).toBe(7);
    const sinNada = validateConfig(PROD);
    expect(sinNada.GATEWAY_TIMEOUT_MS).toBe(5000);
    expect(sinNada.DEBUG_ENDPOINTS_ENABLED).toBe(false);
  });

  it('OPERATOR_BASE_URL no tiene valor por defecto: en producción sería un enlace a localhost', () => {
    expect(validateConfig(PROD).OPERATOR_BASE_URL).toBeUndefined();
    expect(validateConfig({ ...PROD, OPERATOR_BASE_URL: 'https://operator.paytomaxx.com' }).OPERATOR_BASE_URL).toBe(
      'https://operator.paytomaxx.com',
    );
  });

  it('conoce las direcciones de las apps y el dominio de Face ID', () => {
    const env = validateConfig({
      ...PROD,
      NEXT_PUBLIC_OPERATOR_URL: 'https://operator.paytomaxx.com',
      NEXT_PUBLIC_WEB_CLIENT_URL: 'https://pay.paytomaxx.com',
      PASSKEY_RP_ID: 'paytomaxx.com',
    });
    expect(env.NEXT_PUBLIC_OPERATOR_URL).toBe('https://operator.paytomaxx.com');
    expect(env.NEXT_PUBLIC_WEB_CLIENT_URL).toBe('https://pay.paytomaxx.com');
    expect(env.PASSKEY_RP_ID).toBe('paytomaxx.com');
  });

  it('una dirección mal escrita en esas variables nuevas avisa pero no tumba el arranque', () => {
    const env = validateConfig({ ...PROD, NEXT_PUBLIC_OPERATOR_URL: 'operator.paytomaxx.com', PASSKEY_RP_ID: '' });
    expect(env.NEXT_PUBLIC_OPERATOR_URL).toBe('operator.paytomaxx.com');
    expect(envWarnings(env).join('\n')).toMatch(/NEXT_PUBLIC_OPERATOR_URL/);
  });
});

describe('entorno: secretos de ejemplo en producción', () => {
  it.each(['JWT_SECRET', 'COOKIE_SECRET', 'ENCRYPTION_KEK'] as const)(
    'producción no arranca con el %s de .env.example',
    (key) => {
      expect(() => parseEnv({ ...PROD, [key]: DEV_PLACEHOLDER_SECRETS[key] })).toThrow(new RegExp(key));
    },
  );

  it('en local los de ejemplo valen', () => {
    expect(() =>
      parseEnv({ ...BASE, NODE_ENV: 'development', JWT_SECRET: DEV_PLACEHOLDER_SECRETS.JWT_SECRET }),
    ).not.toThrow();
    const fromExample = Object.fromEntries(GUARDED_SECRETS.map((key) => [key, EXAMPLE[key]!]));
    expect(() => parseEnv({ ...BASE, NODE_ENV: 'development', ...fromExample })).not.toThrow();
  });

  // Los de ahora de .env.example (dev-jwt-solo-local-…): la guarda solo
  // conocía los de antes (dev_jwt_a1b2…) y producción arrancaba con estos.
  it.each(GUARDED_SECRETS)('producción no arranca con el %s que trae hoy .env.example', (key) => {
    expect(EXAMPLE[key], `${key} en .env.example`).toBeTruthy();
    expect(() => parseEnv({ ...PROD, [key]: EXAMPLE[key] })).toThrow(new RegExp(key));
  });

  it('ni con uno que lleve las marcas de los de ejemplo (copiado y retocado)', () => {
    for (const value of [
      'mi-jwt-solo-local-no-vale-en-produccion-9876543210',
      'otro-secreto-SOLO-LOCAL-0123456789abcdef0123',
      'xx-no-vale-en-produccion-0123456789abcdef01234',
    ]) {
      expect(() => parseEnv({ ...PROD, JWT_SECRET: value })).toThrow(/JWT_SECRET/);
    }
  });

  it('los de verdad (y los de la CI) siguen valiendo', () => {
    expect(() =>
      parseEnv({
        ...PROD,
        JWT_SECRET: 'ci-jwt-secret-solo-para-la-prueba-0123456789',
        COOKIE_SECRET: '3f9c1e7a5b2d8064c1f3a9e7b5d2086f4c1a3e9b7d5f2086c4e1a3f9b7d5e20',
        ENCRYPTION_KEK: 'Y2ktdW5hLWNsYXZlLWRlLTMyLWJ5dGVzLXBhcmEtcHJ1ZWJh',
      }),
    ).not.toThrow();
  });

  it('todo secreto con valor en .env.example está vigilado (o se dice por qué no)', () => {
    const NOT_GUARDED: Record<string, string> = {
      PEANPE_WEBHOOK_SECRET: 'env.ts la pide, pero el código no la usa para nada',
    };
    const secrets = Object.entries(EXAMPLE).filter(([key, value]) => /SECRET|KEK|TOKEN|PASSWORD|_KEY$/.test(key) && value);
    expect(secrets.length).toBeGreaterThanOrEqual(3);
    for (const [key] of secrets) {
      expect((GUARDED_SECRETS as readonly string[]).includes(key) || key in NOT_GUARDED, key).toBe(true);
    }
  });
});

describe('avisos de arranque (producción)', () => {
  it('Redsys configurado contra el sandbox → aviso', () => {
    const sandbox = validateConfig({ ...PROD, REDSYS_MERCHANT_CODE: '123456789' });
    expect(envWarnings(sandbox).join('\n')).toMatch(/REDSYS_API_URL.*sandbox/i);
    const real = validateConfig({
      ...PROD,
      REDSYS_MERCHANT_CODE: '123456789',
      REDSYS_API_URL: 'https://sis.redsys.es/sis/realizarPago',
    });
    expect(envWarnings(real).join('\n')).not.toMatch(/REDSYS_API_URL/);
  });

  it('sin ORIGIN_AUTH_SECRET ni METRICS_TOKEN → avisos (no fallo)', () => {
    const text = envWarnings(validateConfig(PROD)).join('\n');
    expect(text).toMatch(/ORIGIN_AUTH_SECRET/);
    expect(text).toMatch(/METRICS_TOKEN/);
    const completo = validateConfig({
      ...PROD,
      ORIGIN_AUTH_SECRET: 'x'.repeat(32),
      METRICS_TOKEN: 'm'.repeat(32),
    });
    expect(envWarnings(completo).join('\n')).not.toMatch(/ORIGIN_AUTH_SECRET|METRICS_TOKEN/);
  });

  it('secreto de Paytef corto → aviso', () => {
    const corto = validateConfig({ ...PROD, PAYTEF_WEBHOOK_SECRET: 'corto' });
    expect(envWarnings(corto).join('\n')).toMatch(/PAYTEF_WEBHOOK_SECRET/);
    const largo = validateConfig({ ...PROD, PAYTEF_WEBHOOK_SECRET: 'a'.repeat(32) });
    expect(envWarnings(largo).join('\n')).not.toMatch(/PAYTEF_WEBHOOK_SECRET/);
  });

  it('Paytef activo sin secreto de avisos → aviso (los avisos se rechazan)', () => {
    const sinSecreto = validateConfig({ ...PROD, PAYTEF_API_TOKEN: 'tok' });
    expect(envWarnings(sinSecreto).join('\n')).toMatch(/PAYTEF_WEBHOOK_SECRET no está definido/);
    const conSecreto = validateConfig({ ...PROD, PAYTEF_API_TOKEN: 'tok', PAYTEF_WEBHOOK_SECRET: 'a'.repeat(32) });
    expect(envWarnings(conSecreto).join('\n')).not.toMatch(/PAYTEF_WEBHOOK_SECRET/);
  });

  it('PAYTEF_FORCE_TEST distinto de true/false → aviso (se ignora)', () => {
    expect(envWarnings(validateConfig({ ...PROD, PAYTEF_FORCE_TEST: 'TRUE' })).join('\n')).toMatch(/PAYTEF_FORCE_TEST/);
    expect(envWarnings(validateConfig({ ...PROD, PAYTEF_FORCE_TEST: 'true' })).join('\n')).not.toMatch(/PAYTEF_FORCE_TEST/);
  });

  it('debug abierto en producción → aviso', () => {
    const env = validateConfig({ ...PROD, DEBUG_ENDPOINTS_ENABLED: 'true' });
    expect(envWarnings(env).join('\n')).toMatch(/DEBUG_ENDPOINTS_ENABLED/);
  });

  it('en local no se avisa de lo que solo importa en producción', () => {
    const env = validateConfig({ ...BASE, NODE_ENV: 'development' });
    expect(envWarnings(env)).toEqual([]);
  });
});

describe('entorno: REALTIME_LEGACY_SUBSCRIBE_UNTIL (tiempo real sin sesión)', () => {
  it('opcional; fecha ISO con zona u "off"', () => {
    expect(validateConfig(PROD).REALTIME_LEGACY_SUBSCRIBE_UNTIL).toBeUndefined();
    for (const ok of ['2026-12-01T00:00:00+01:00', '2026-12-01T00:00Z', ' off ', 'OFF', '']) {
      expect(() => validateConfig({ ...PROD, REALTIME_LEGACY_SUBSCRIBE_UNTIL: ok })).not.toThrow();
    }
  });

  it('una fecha sin zona o mal escrita no arranca, y dice qué variable es', () => {
    for (const bad of ['2026-11-15', '2026-11-15T00:00:00', '15/11/2026', 'nunca', '2026-13-45T00:00:00Z']) {
      expect(() => validateConfig({ ...PROD, REALTIME_LEGACY_SUBSCRIBE_UNTIL: bad })).toThrow(
        /REALTIME_LEGACY_SUBSCRIBE_UNTIL/,
      );
    }
  });
});

describe('entorno: AUTH_BODY_REFRESH_UNTIL (refresh token en el cuerpo, apps antiguas)', () => {
  it('opcional; fecha ISO con zona u "off"', () => {
    expect(validateConfig(PROD).AUTH_BODY_REFRESH_UNTIL).toBeUndefined();
    for (const ok of ['2026-12-15T00:00:00+01:00', '2026-12-01T00:00Z', ' off ', 'OFF', '']) {
      expect(() => validateConfig({ ...PROD, AUTH_BODY_REFRESH_UNTIL: ok })).not.toThrow();
    }
  });

  it('una fecha sin zona o mal escrita no arranca, y dice qué variable es', () => {
    for (const bad of ['2026-11-30', '2026-11-30T00:00:00', '30/11/2026', 'nunca']) {
      expect(() => validateConfig({ ...PROD, AUTH_BODY_REFRESH_UNTIL: bad })).toThrow(/AUTH_BODY_REFRESH_UNTIL/);
    }
  });
});

describe('entorno: API de socios', () => {
  const DEV = { ...BASE, NODE_ENV: 'development' };

  it('apagada de serie; encendida necesita PARTNER_API_MODE (live o test), sin valor por defecto, también en local', () => {
    expect(parseEnv(DEV).PARTNER_API_ENABLED).toBe(false);
    expect(() => parseEnv({ ...DEV, PARTNER_API_ENABLED: 'true' })).toThrow(/PARTNER_API_MODE/);
    expect(() => parseEnv({ ...DEV, PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'prod' })).toThrow(InvalidEnvError);
    const env = parseEnv({ ...DEV, PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'test' });
    expect(env).toMatchObject({ PARTNER_API_ENABLED: true, PARTNER_API_MODE: 'test' });
  });

  it('en producción, live sin ORIGIN_AUTH_SECRET no arranca (la lista de IP se saltaría con una cabecera inventada)', () => {
    const live = { ...PROD, PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'live' };
    expect(() => parseEnv(live)).toThrow(/ORIGIN_AUTH_SECRET/);
    expect(parseEnv({ ...live, ORIGIN_AUTH_SECRET: 'secreto-de-cloudflare-0123456789' }).PARTNER_API_MODE).toBe('live');
    expect(parseEnv({ ...PROD, PARTNER_API_ENABLED: 'true', PARTNER_API_MODE: 'test' }).PARTNER_API_MODE).toBe('test');
  });

  it('NIGHTPAY_DISABLE_PARTNER_SWEEP=1 avisa en producción', () => {
    expect(Object.keys(DISABLE_FLAGS)).toContain('NIGHTPAY_DISABLE_PARTNER_SWEEP');
    expect(envWarnings(validateConfig({ ...PROD, NIGHTPAY_DISABLE_PARTNER_SWEEP: '1' })).join('\n')).toMatch(/NIGHTPAY_DISABLE_PARTNER_SWEEP=1/);
  });
});
