import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { SoftAuthenticator } from '../wallets/testing/soft-authenticator';
import { createFakeRedis } from './testing/fake-redis';
import { StaffPasskeysService } from './staff-passkeys.service';
import { staffRelyingParty } from './staff-passkey-rp';
import { totpForbidden } from './totp-code';

const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const NEREA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d02';
const SALA = 'a1a1a1a1-0000-4000-8000-000000000001';
const SID = '11111111-1111-4111-8111-111111111111';
const APP = 'https://operator.paytomaxx.com';
const PASSWORD = 'contraseña-de-lola';
const HASH = bcrypt.hashSync(PASSWORD, 4);

type Row = { id: string; userId: string; credentialId: string; publicKey: Buffer; counter: bigint; transports: string[]; name: string; createdAt: Date; lastUsedAt: Date | null };

function setup(o: { totp?: boolean } = {}) {
  const rows: Row[] = [];
  let n = 0;
  const pick = (r: Row, select?: Record<string, boolean>) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k as keyof Row]])) : r);
  const staffPasskey = {
    count: vi.fn(async ({ where }: { where: { userId: string } }) => rows.filter((r) => r.userId === where.userId).length),
    findMany: vi.fn(async ({ where, select }: { where: { userId: string }; select?: Record<string, boolean> }) =>
      rows.filter((r) => r.userId === where.userId).map((r) => pick(r, select)),
    ),
    findUnique: vi.fn(async ({ where, select }: { where: { credentialId: string }; select?: Record<string, boolean> }) => {
      const r = rows.find((x) => x.credentialId === where.credentialId);
      return r ? pick(r, select) : null;
    }),
    create: vi.fn(async ({ data, select }: { data: Omit<Row, 'id' | 'createdAt' | 'lastUsedAt'>; select?: Record<string, boolean> }) => {
      const r: Row = { id: `pk-${(n += 1)}`, createdAt: new Date('2026-11-08T00:00:00Z'), lastUsedAt: null, ...data };
      rows.push(r);
      return pick(r, select);
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
    deleteMany: vi.fn(async ({ where }: { where: { id?: string; userId: string } }) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]!.userId === where.userId && (!where.id || rows[i]!.id === where.id)) rows.splice(i, 1);
      }
      return { count: before - rows.length };
    }),
  };
  const users = new Map([
    [LOLA, { id: LOLA, email: 'lola@bambu.es', displayName: 'Lola', passwordHash: HASH, tenantId: SALA, deletedAt: null }],
    [NEREA, { id: NEREA, email: 'nerea@bambu.es', displayName: 'Nerea', passwordHash: HASH, tenantId: SALA, deletedAt: null }],
  ]);
  const tx = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
        const u = users.get(where.id);
        return u && u.tenantId === where.tenantId ? { id: u.id } : null;
      }),
    },
  };
  const prisma = { staffPasskey, acrossVenues: async (fn: (t: typeof tx) => unknown) => fn(tx), asSystem: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  const redis = Object.assign(createFakeRedis(), {});
  const totp = {
    isEnabled: vi.fn(async () => o.totp ?? false),
    assertForUser: vi.fn(async (_u: string, code: string | undefined) => {
      if (code !== '123456') throw totpForbidden(code ? 'invalid' : 'required');
    }),
  };
  const lockout = { reserveAttempt: vi.fn(async () => ({ allowed: true, ttlSeconds: 0 })), clear: vi.fn(async () => undefined) };
  const audit = { log: vi.fn(async () => undefined) };
  const cls = { get: () => ({ device: { model: 'iPhone', os: 'iOS', osVersion: '18', browser: 'Safari 18', mobile: true, inApp: null, ip: '10.0.0.7' } }) };
  const svc = new StaffPasskeysService(prisma as never, redis as never, totp as never, lockout as never, audit as never, cls as never);
  return { svc, rows, totp, audit, lockout };
}

const lola = { userId: LOLA, sessionId: SID, tenantId: SALA, email: 'lola@bambu.es' };

async function enrolled(s: ReturnType<typeof setup>, phone = new SoftAuthenticator()) {
  const opts = await s.svc.registrationOptions(lola, PASSWORD, undefined, APP);
  await s.svc.register(lola, phone.register(opts.challenge, APP), undefined, APP);
  return phone;
}

beforeEach(() => {
  vi.stubEnv('CORS_ORIGINS', 'https://admin.paytomaxx.com,https://operator.paytomaxx.com');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PASSKEY_RP_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dar de alta una llave de acceso del personal', () => {
  it('con la contraseña: guarda solo la clave pública, con el nombre del móvil, y queda en el registro', async () => {
    const s = setup();
    await enrolled(s);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ userId: LOLA, name: 'iPhone · iOS 18' });
    expect(await s.svc.list(LOLA)).toEqual([{ id: 'pk-1', label: 'iPhone · iOS 18', createdAt: '2026-11-08T00:00:00.000Z', lastUsedAt: null }]);
    expect(s.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.passkey.added', actorId: LOLA }));
  });

  it('las opciones: el dominio común y la verificación del móvil obligatoria; no residentes (el selector del cliente no la ofrece)', async () => {
    const opts = await setup().svc.registrationOptions(lola, PASSWORD, undefined, APP);
    expect(opts.rp.id).toBe('paytomaxx.com');
    expect(opts.authenticatorSelection).toMatchObject({ residentKey: 'discouraged', userVerification: 'required' });
  });

  it('contraseña mala: 403 PASSWORD_INVALID, nada guardado y al registro', async () => {
    const s = setup();
    await expect(s.svc.registrationOptions(lola, 'otra', undefined, APP)).rejects.toMatchObject({ response: { code: 'PASSWORD_INVALID' } });
    expect(s.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.passkey.password_failed' }));
    expect(s.lockout.clear).not.toHaveBeenCalled();
  });

  it('con 2FA: además, su código', async () => {
    const s = setup({ totp: true });
    await expect(s.svc.registrationOptions(lola, PASSWORD, undefined, APP)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    await expect(s.svc.registrationOptions(lola, PASSWORD, '123456', APP)).resolves.toHaveProperty('challenge');
  });

  it('el alta empezada en otra sesión (u otra persona) no se termina; la misma respuesta dos veces, tampoco', async () => {
    const s = setup();
    const phone = new SoftAuthenticator();
    const opts = await s.svc.registrationOptions(lola, PASSWORD, undefined, APP);
    const response = phone.register(opts.challenge, APP);
    await expect(s.svc.register({ ...lola, sessionId: 'otra-sesion' }, response, undefined, APP)).rejects.toMatchObject({ response: { code: 'PASSKEY_TIMEOUT' } });
    await s.svc.register(lola, response, 'Mi iPhone', APP);
    await expect(s.svc.register(lola, response, undefined, APP)).rejects.toMatchObject({ response: { code: 'PASSKEY_TIMEOUT' } });
    expect(s.rows.map((r) => r.name)).toEqual(['Mi iPhone']);
  });

  it('firmada desde una web que no es nuestra: no vale', async () => {
    const s = setup();
    const opts = await s.svc.registrationOptions(lola, PASSWORD, undefined, APP);
    await expect(s.svc.register(lola, new SoftAuthenticator().register(opts.challenge, 'https://paytomaxx.evil.com'), undefined, APP)).rejects.toMatchObject({
      response: { code: 'PASSKEY_FAILED' },
    });
  });
});

describe('verificarse con la llave', () => {
  it('el reto lleva solo sus llaves; sin ninguna, 403 PASSKEY_NOT_SET', async () => {
    const s = setup();
    await expect(s.svc.authenticationOptions(lola, 'view', APP)).rejects.toMatchObject({ response: { code: 'PASSKEY_NOT_SET' } });
    await enrolled(s);
    const opts = await s.svc.authenticationOptions(lola, 'view', APP);
    expect(opts.allowCredentials?.map((c) => c.id)).toEqual([s.rows[0]!.credentialId]);
    expect(opts.userVerification).toBe('required');
  });

  it('con su móvil: vale una vez (el contador sube y se apunta cuándo)', async () => {
    const s = setup();
    const phone = await enrolled(s);
    const opts = await s.svc.authenticationOptions(lola, 'view', APP);
    const signed = phone.assert(opts.challenge, { origin: APP });
    await s.svc.verify(lola, 'view', signed, APP);
    expect(s.rows[0]!.counter).toBe(1n);
    expect(s.rows[0]!.lastUsedAt).toBeInstanceOf(Date);
    await expect(s.svc.verify(lola, 'view', signed, APP)).rejects.toMatchObject({ response: { code: 'PASSKEY_TIMEOUT' } });
  });

  it('el reto de una acción no vale para otra (ni para ver)', async () => {
    const s = setup();
    const phone = await enrolled(s);
    const opts = await s.svc.authenticationOptions(lola, 'action:refund:p:1000', APP);
    await expect(s.svc.verify(lola, 'action:refund:p:9999', phone.assert(opts.challenge, { origin: APP }), APP)).rejects.toMatchObject({
      response: { code: 'PASSKEY_TIMEOUT' },
    });
  });

  it('la llave de otra persona no vale aunque firme bien', async () => {
    const s = setup();
    const phone = await enrolled(s);
    const opts = await s.svc.authenticationOptions(lola, 'view', APP);
    await expect(s.svc.verify({ ...lola, userId: NEREA }, 'view', phone.assert(opts.challenge, { origin: APP }), APP)).rejects.toMatchObject({
      response: { code: 'PASSKEY_UNKNOWN' },
    });
  });

  it('sin desbloquear el móvil (sin verificación del usuario): no vale', async () => {
    const s = setup();
    const phone = await enrolled(s);
    const opts = await s.svc.authenticationOptions(lola, 'view', APP);
    await expect(s.svc.verify(lola, 'view', phone.assert(opts.challenge, { origin: APP, userVerified: false }), APP)).rejects.toMatchObject({
      response: { code: 'PASSKEY_FAILED' },
    });
  });
});

describe('quitar llaves', () => {
  it('cada uno las suyas (la de otra persona, 404); el dueño, las de alguien de su local', async () => {
    const s = setup();
    await enrolled(s);
    await expect(s.svc.remove({ ...lola, userId: NEREA }, 'pk-1')).rejects.toMatchObject({ status: 404 });
    await s.svc.remove(lola, 'pk-1');
    expect(s.rows).toEqual([]);
    await enrolled(s);
    expect(await s.svc.removeAllOf({ userId: 'duena', tenantId: SALA }, LOLA)).toBe(1);
    await expect(s.svc.removeAllOf({ userId: 'duena', tenantId: 'otro-local' }, LOLA)).rejects.toMatchObject({ status: 404 });
  });
});

describe('dónde valen', () => {
  it('las apps del personal de CORS_ORIGINS, con el dominio común; en local, las de localhost', () => {
    expect(staffRelyingParty('https://admin.paytomaxx.com', { corsOrigins: 'https://admin.paytomaxx.com,https://operator.paytomaxx.com', production: true })).toEqual({
      rpID: 'paytomaxx.com',
      rpIDs: ['paytomaxx.com'],
      origins: ['https://admin.paytomaxx.com', 'https://operator.paytomaxx.com'],
    });
    expect(staffRelyingParty('https://evil.com', { corsOrigins: 'https://admin.paytomaxx.com', production: true }).rpID).toBe('paytomaxx.com');
    expect(staffRelyingParty(undefined, { production: false }).origins).toContain('http://localhost:4104');
    expect(staffRelyingParty(undefined, { corsOrigins: 'https://admin.sala.com.es', rpId: 'sala.com.es', production: true }).rpID).toBe('sala.com.es');
  });
});
