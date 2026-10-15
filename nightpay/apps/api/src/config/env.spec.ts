import { describe, it, expect } from 'vitest';
import { DEV_PLACEHOLDER_SECRETS, InvalidEnvError, parseEnv, validateConfig } from './env';
import { envWarnings } from './env-warnings';

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
};

describe('entorno: NODE_ENV', () => {
  it('sin NODE_ENV se asume producción (lo seguro), y entonces exige la URL pública del API', () => {
    expect(() => parseEnv(BASE)).toThrow(InvalidEnvError);
    expect(() => parseEnv(BASE)).toThrow(/NEXT_PUBLIC_API_URL/);
    const env = parseEnv({ ...BASE, NEXT_PUBLIC_API_URL: 'https://api.paytomaxx.com' });
    expect(env.NODE_ENV).toBe('production');
  });

  it('en local hay que decirlo: NODE_ENV=development', () => {
    expect(parseEnv({ ...BASE, NODE_ENV: 'development' }).NODE_ENV).toBe('development');
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
