import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { bearerToken, verifyStaffToken } from './staff-token';

const SECRET = 'jwt-secreto-de-prueba-para-staff-0123456789';
const NOW = new Date('2026-10-16T23:30:00Z'); // viernes noche
const NOW_S = Math.floor(NOW.getTime() / 1000);

const PAYLOAD = {
  sub: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  email: 'encargada@sala-luna.es',
  role: 'MANAGER',
  tenantId: '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01',
  venueSlug: 'luna',
};

const jwt = new JwtService({ secret: SECRET });
const sign = (claims: object, secret = SECRET) =>
  jwt.signAsync({ iat: NOW_S, exp: NOW_S + 900, ...claims }, { secret });

function b64url(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('verifyStaffToken', () => {
  it('sesión válida → ok con el payload validado', async () => {
    const res = await verifyStaffToken(jwt, await sign(PAYLOAD));
    expect(res).toMatchObject({ ok: true, payload: { sub: PAYLOAD.sub, role: 'MANAGER', tenantId: PAYLOAD.tenantId } });
  });

  it('claims de más (isSuperAdmin, permisos) se descartan: no llegan a req.user', async () => {
    const res = await verifyStaffToken(jwt, await sign({ ...PAYLOAD, isSuperAdmin: true, scope: 'admin:*' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload).not.toHaveProperty('isSuperAdmin');
      expect(res.payload).not.toHaveProperty('scope');
    }
  });

  it('firmado con otra clave → invalid', async () => {
    const res = await verifyStaffToken(jwt, await sign(PAYLOAD, 'otra-clave-de-otro-entorno-0123456789'));
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });

  it('caducado (exp un segundo antes de ahora) → invalid', async () => {
    const res = await verifyStaffToken(jwt, await sign({ ...PAYLOAD, iat: NOW_S - 901, exp: NOW_S - 1 }));
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });

  it('sin firma (alg "none") → invalid', async () => {
    const token = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ ...PAYLOAD, iat: NOW_S, exp: NOW_S + 900 })}.`;
    expect(await verifyStaffToken(jwt, token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('payload manipulado (rol cambiado sin volver a firmar) → invalid', async () => {
    const [h, , s] = (await sign(PAYLOAD)).split('.');
    const forged = `${h}.${b64url({ ...PAYLOAD, role: 'OWNER', iat: NOW_S, exp: NOW_S + 900 })}.${s}`;
    expect(await verifyStaffToken(jwt, forged)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('JWT de un solo uso (purpose) con firma buena → malformed', async () => {
    for (const purpose of ['operator-invite', 'self-onboarding', '']) {
      expect(await verifyStaffToken(jwt, await sign({ ...PAYLOAD, purpose }))).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it.each([
    ['rol fuera del enum', { role: 'SUPERADMIN' }],
    ['tenantId que no es UUID', { tenantId: 'luna' }],
    ['sin sub', { sub: undefined }],
    ['email inválido', { email: 'no-es-email' }],
  ])('firma buena pero %s → malformed', async (_caso, cambio) => {
    expect(await verifyStaffToken(jwt, await sign({ ...PAYLOAD, ...cambio }))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('payload que no es un objeto (texto firmado) → malformed', async () => {
    const fake = { verifyAsync: vi.fn().mockResolvedValue('texto-firmado') };
    expect(await verifyStaffToken(fake as never, 't')).toEqual({ ok: false, reason: 'malformed' });
    fake.verifyAsync.mockResolvedValue(null);
    expect(await verifyStaffToken(fake as never, 't')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('bearerToken', () => {
  it('extrae el token y recorta espacios', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('Bearer   abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it.each([
    ['vacío tras Bearer', 'Bearer    '],
    ['sin espacio', 'Bearerabc'],
    ['en minúsculas', 'bearer abc'],
    ['otro esquema', 'Basic YWRtaW46YWRtaW4='],
    ['del datáfono', 'Device credencial'],
  ])('%s → null', (_caso, header) => {
    expect(bearerToken(header)).toBeNull();
  });

  it('cabecera repetida (array), número o ausente → null', () => {
    expect(bearerToken(['Bearer a', 'Bearer b'])).toBeNull();
    expect(bearerToken(42)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
