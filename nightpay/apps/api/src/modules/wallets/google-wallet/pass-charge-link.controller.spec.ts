import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PassChargeLinkController } from './pass-charge-link.controller';
import { passChargeToken } from './pass-charge-token';

const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const TOKEN = passChargeToken('secreto', WALLET, 'enlace-del-saldo-del-cliente-0001');

function controller(env: Record<string, string | undefined>) {
  return new PassChargeLinkController({ get: (k: string) => env[k] } as never);
}

describe('GET /c/:token — el QR del pase leído con la cámara del móvil', () => {
  it('lleva a la app del personal con ?pase=<token> (302, sin caché)', () => {
    const c = controller({ OPERATOR_BASE_URL: 'https://chicas.oxiopay.es/', NODE_ENV: 'production' });
    expect(c.open(TOKEN)).toEqual({ url: `https://chicas.oxiopay.es/?pase=${TOKEN}`, statusCode: 302 });
  });

  it('sin OPERATOR_BASE_URL: la del API con operator. (como el resto de enlaces de la app)', () => {
    const c = controller({ NEXT_PUBLIC_API_URL: 'https://api.oxiopay.es', NODE_ENV: 'production' });
    expect(c.open(TOKEN).url).toBe(`https://operator.oxiopay.es/?pase=${TOKEN}`);
  });

  it('lo que no tiene la forma del token de cobro (el enlace del saldo, basura) → 404, sin mirar nada', () => {
    const c = controller({ OPERATOR_BASE_URL: 'https://chicas.oxiopay.es' });
    for (const bad of ['enlace-del-saldo-del-cliente-0001', `${TOKEN}A`, TOKEN.slice(1), `${TOKEN.slice(0, 42)}+`]) {
      expect(() => c.open(bad)).toThrow(NotFoundException);
    }
  });

  it('en producción sin saber dónde está la app → 404 (no se manda a ningún sitio inventado)', () => {
    const c = controller({ NEXT_PUBLIC_API_URL: 'https://pagos.oxiopay.es', NODE_ENV: 'production' });
    expect(() => c.open(TOKEN)).toThrow(NotFoundException);
  });
});
