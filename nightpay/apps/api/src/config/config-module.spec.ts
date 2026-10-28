import { afterEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { configModuleOptions } from './env';

const REQUIRED: Record<string, string> = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_API_URL: 'https://api.paytomaxx.com',
  CORS_ORIGINS: 'https://admin.paytomaxx.com',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'jwt-de-prueba-0123456789abcdef0123456789',
  COOKIE_SECRET: 'cookie-de-prueba-0123456789abcdef012345',
  ENCRYPTION_KEK: 'kek-de-prueba-0123456789abcdef0123456789',
  PEANPE_API_URL: 'http://localhost:4902',
  PEANPE_WEBHOOK_SECRET: 'secreto-peanpe',
  GATEWAY_TIMEOUT_MS: '7000',
  PAYTEF_COMPANY_ID: '76861',
};

const snapshot = { ...process.env };

afterEach(() => {
  // ConfigModule escribe en process.env los valores por defecto: se deja como estaba.
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
});

async function configFor(env: Record<string, string>): Promise<ConfigService> {
  Object.assign(process.env, env);
  for (const key of ['OPERATOR_BASE_URL', 'REDSYS_API_URL', 'DEBUG_ENDPOINTS_ENABLED']) {
    if (!(key in env)) delete process.env[key];
  }
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ ...configModuleOptions(), ignoreEnvFile: true })],
  }).compile();
  return moduleRef.get(ConfigService);
}

describe('ConfigService con el entorno ya validado por zod', () => {
  it('devuelve números y booleanos convertidos, no el texto de process.env', async () => {
    const config = await configFor(REQUIRED);
    expect(config.get('GATEWAY_TIMEOUT_MS')).toBe(7000);
    expect(config.get('PAYTEF_COMPANY_ID')).toBe(76861);
    expect(config.get('DEBUG_ENDPOINTS_ENABLED')).toBe(false);
  });

  it('ve los valores por defecto del esquema (antes eran invisibles)', async () => {
    const config = await configFor(REQUIRED);
    expect(config.get('REDSYS_API_URL')).toBe('https://sis-t.redsys.es:25443/sis/realizarPago');
    expect(config.get('PAYOUT_HOLD_DAYS')).toBe(7);
    expect(config.getOrThrow('PAYOUT_HOLD_DAYS')).toBe(7);
    expect(() => config.getOrThrow('OPERATOR_BASE_URL')).toThrow();
    expect(config.get('NODE_ENV')).toBe('production');
  });

  it('sin OPERATOR_BASE_URL no se inventa localhost (lo deduce operator-app-url.ts)', async () => {
    const config = await configFor(REQUIRED);
    expect(config.get('OPERATOR_BASE_URL')).toBeUndefined();
  });

  it('las variables que no están en el esquema se siguen leyendo de process.env', async () => {
    const config = await configFor({ ...REQUIRED, PAYTEF_BRANCH_NAME: 'RSR5' });
    expect(config.get('PAYTEF_BRANCH_NAME')).toBe('RSR5');
  });
});
