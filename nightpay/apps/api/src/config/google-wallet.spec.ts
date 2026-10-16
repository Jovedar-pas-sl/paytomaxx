import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { googleWalletWarning, readGoogleWalletConfig, DEFAULT_GOOGLE_WALLET_CLASS_SUFFIX } from './google-wallet';
import { validateConfig } from './env';
import { envWarnings } from './env-warnings';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SA = {
  type: 'service_account',
  project_id: 'oxiopay',
  private_key_id: 'abc123',
  private_key: PEM,
  client_email: 'wallet@oxiopay.iam.gserviceaccount.com',
};
const JSON_SA = JSON.stringify(SA);
const ISSUER = '3388000000012345678';

const BASE: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'jwt-de-prueba-0123456789abcdef0123456789',
  COOKIE_SECRET: 'cookie-de-prueba-0123456789abcdef012345',
  ENCRYPTION_KEK: 'kek-de-prueba-0123456789abcdef0123456789',
  PEANPE_API_URL: 'http://localhost:4902',
  PEANPE_WEBHOOK_SECRET: 'secreto-peanpe',
};

describe('Google Wallet: sin configurar no hay nada', () => {
  it('sin emisor ni clave → apagado y sin avisos', () => {
    expect(readGoogleWalletConfig({})).toEqual({ status: 'off' });
    expect(readGoogleWalletConfig({ GOOGLE_WALLET_CLASS_SUFFIX: 'otra' })).toEqual({ status: 'off' });
    expect(readGoogleWalletConfig({ GOOGLE_WALLET_ISSUER_ID: '  ', GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: '' })).toEqual({
      status: 'off',
    });
    expect(googleWalletWarning({})).toBeNull();
  });

  it('env.ts las conoce: el sufijo de la clase tiene valor por defecto y el resto es opcional', () => {
    const env = validateConfig(BASE);
    expect(env.GOOGLE_WALLET_CLASS_SUFFIX).toBe(DEFAULT_GOOGLE_WALLET_CLASS_SUFFIX);
    expect(env.GOOGLE_WALLET_ISSUER_ID).toBeUndefined();
    expect(envWarnings(env).some((w) => w.includes('Google Wallet'))).toBe(false);
  });
});

describe('Google Wallet: configurado', () => {
  it('emisor + JSON de la cuenta de servicio → activo, con la clase <emisor>.<sufijo>', () => {
    const config = readGoogleWalletConfig({ GOOGLE_WALLET_ISSUER_ID: ISSUER, GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON_SA });
    expect(config.status).toBe('on');
    if (config.status !== 'on') return;
    expect(config.settings).toMatchObject({
      issuerId: ISSUER,
      classSuffix: 'oxiopay_saldo',
      classId: `${ISSUER}.oxiopay_saldo`,
      serviceAccountEmail: SA.client_email,
      privateKeyId: 'abc123',
    });
    expect(config.settings.privateKey.asymmetricKeyType).toBe('rsa');
  });

  it('el mismo JSON en base64 (_B64) también vale, y otro sufijo de clase', () => {
    const config = readGoogleWalletConfig({
      GOOGLE_WALLET_ISSUER_ID: ISSUER,
      GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64: Buffer.from(JSON_SA).toString('base64'),
      GOOGLE_WALLET_CLASS_SUFFIX: 'saldo_pruebas',
    });
    expect(config.status === 'on' && config.settings.classId).toBe(`${ISSUER}.saldo_pruebas`);
  });

  it('clave pegada con los saltos de línea como "\\n" literales → se arregla', () => {
    const flat = JSON.stringify({ ...SA, private_key: PEM.split('\n').join('\\n') });
    const config = readGoogleWalletConfig({ GOOGLE_WALLET_ISSUER_ID: ISSUER, GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: flat });
    expect(config.status).toBe('on');
  });
});

describe('Google Wallet: mal configurado → apagado y aviso al arrancar (sin tumbar el API)', () => {
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ['falta la clave', { GOOGLE_WALLET_ISSUER_ID: ISSUER }, /falta GOOGLE_WALLET_SERVICE_ACCOUNT_JSON/],
    ['falta el emisor', { GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON_SA }, /falta GOOGLE_WALLET_ISSUER_ID/],
    ['emisor con letras', { GOOGLE_WALLET_ISSUER_ID: 'BCR2DN4T', GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON_SA }, /solo cifras/],
    ['JSON roto', { GOOGLE_WALLET_ISSUER_ID: ISSUER, GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: '{"type":' }, /no es un JSON válido/],
    [
      'no es de cuenta de servicio',
      { GOOGLE_WALLET_ISSUER_ID: ISSUER, GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...SA, type: 'authorized_user' }) },
      /service_account/,
    ],
    [
      'clave que no es RSA',
      { GOOGLE_WALLET_ISSUER_ID: ISSUER, GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...SA, private_key: 'nada' }) },
      /clave RSA válida/,
    ],
    [
      'las dos versiones a la vez',
      {
        GOOGLE_WALLET_ISSUER_ID: ISSUER,
        GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON_SA,
        GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64: Buffer.from(JSON_SA).toString('base64'),
      },
      /pon solo una/,
    ],
    [
      'sufijo con espacios',
      { GOOGLE_WALLET_ISSUER_ID: ISSUER, GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON_SA, GOOGLE_WALLET_CLASS_SUFFIX: 'mi saldo' },
      /GOOGLE_WALLET_CLASS_SUFFIX/,
    ],
  ];

  it.each(cases)('%s', (_name, env, problem) => {
    const config = readGoogleWalletConfig(env);
    expect(config.status).toBe('invalid');
    expect(googleWalletWarning(env)).toMatch(problem);
  });

  it('el aviso dice qué falla, nunca el valor: ni la clave privada ni el email', () => {
    const env = { GOOGLE_WALLET_ISSUER_ID: 'x', GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON_SA };
    const warning = googleWalletWarning(env) ?? '';
    expect(warning).toMatch(/Google Wallet queda apagado/);
    expect(warning).not.toContain('PRIVATE KEY');
    expect(warning).not.toContain(PEM.slice(40, 80));
    expect(warning).not.toContain(SA.client_email);
  });

  it('sale en los avisos de arranque (envWarnings) y el API arranca igual', () => {
    const env = validateConfig({ ...BASE, GOOGLE_WALLET_ISSUER_ID: ISSUER });
    expect(envWarnings(env).filter((w) => w.includes('Google Wallet'))).toHaveLength(1);
  });
});
