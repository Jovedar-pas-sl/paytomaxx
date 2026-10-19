import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { OperatorsService } from './operators.service';

// Sala Bambú (Madrid): Javier (dueño) gestiona el acceso de Lucía Fernández.
const TENANT = '5b8e2c1a-3f4d-4a6b-9c7e-1d2f3a4b5c6d';
const OTHER_TENANT = '7d6c5b4a-3e2f-4a1b-9c0d-8e7f6a5b4c3d';
const OPERATOR = 'a1c3e5f7-2b4d-4e6f-8a0b-9c8d7e6f5a4b';
const OWNER = '0f1e2d3c-4b5a-4968-8776-655443322110';
const APP_URL = 'https://chicas.oxiopay.es';
const NOW = new Date('2026-10-16T23:15:00+02:00');
/** Sin 0/O, 1/l/I: se lee bien al dictarla por WhatsApp. */
const READABLE_12 = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{12}$/;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface UserRow {
  id: string;
  tenantId: string;
  role: string;
  email: string;
  deletedAt: Date | null;
  invitedAt: Date | null;
  inviteToken: string | null;
  passwordHash: string;
}

interface Opts {
  user?: Partial<UserRow> | null;
  /** Sin dirección de la app de las chicas (producción sin OPERATOR_BASE_URL). */
  noAppUrl?: boolean;
}

function makeService(opts: Opts = {}) {
  let row: UserRow | null =
    opts.user === null
      ? null
      : {
          id: OPERATOR,
          tenantId: TENANT,
          role: 'OPERATOR',
          email: 'lucia.fernandez@gmail.com',
          deletedAt: null,
          invitedAt: new Date('2026-10-14T21:00:00+02:00'),
          inviteToken: null,
          passwordHash: '$2a$04$marcadordeposicion',
          ...(opts.user ?? {}),
        };
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (row && row.id === where.id ? row : null)),
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string; role: string } }) =>
        row && row.id === where.id && row.tenantId === where.tenantId && row.role === where.role ? row : null,
      ),
      update: vi.fn(async ({ data }: { where: { id: string }; data: Partial<UserRow> }) => {
        row = { ...row!, ...data };
        return row;
      }),
    },
    asSystem: vi.fn(),
  };
  prisma.asSystem.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));

  // JWT de mentira: firma tokens distintos y solo verifica los que firmó (y no caducados).
  const issued = new Map<string, Record<string, unknown>>();
  const expired = new Set<string>();
  const jwt = {
    signAsync: vi.fn(async (payload: Record<string, unknown>) => {
      const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.firma${issued.size + 1}`;
      issued.set(token, payload);
      return token;
    }),
    verifyAsync: vi.fn(async (token: string) => {
      const payload = issued.get(token);
      if (!payload || expired.has(token)) throw new Error('jwt expired');
      return payload;
    }),
  };
  const config = {
    get: vi.fn((k: string) => {
      if (k === 'NODE_ENV') return 'production';
      if (k === 'OPERATOR_BASE_URL') return opts.noAppUrl ? undefined : APP_URL;
      return undefined;
    }),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new OperatorsService(prisma as never, {} as never, audit as never, config as never, jwt as never, {} as never);

  /** Invitación vigente: el token firmado y su hash guardado en la chica. */
  async function invite(payload: Record<string, unknown> = { sub: OPERATOR, tenantId: TENANT, purpose: 'operator-invite' }) {
    const token = await jwt.signAsync(payload);
    row = { ...row!, inviteToken: sha256(token) };
    return token;
  }
  return { svc, prisma, jwt, audit, invite, expire: (t: string) => expired.add(t), current: () => row! };
}

beforeEach(() => {
  // Solo el reloj: bcrypt sigue usando setImmediate de verdad.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OperatorsService.acceptInvite — la chica activa su cuenta', () => {
  it('contraseña de menos de 8 caracteres → 400 sin mirar el token', async () => {
    const { svc, jwt, invite } = makeService();
    const token = await invite();
    await expect(svc.acceptInvite(token, 'Bambu26')).rejects.toBeInstanceOf(BadRequestException);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('token bueno (8 caracteres justos): guarda el hash de la contraseña y anula la invitación', async () => {
    const { svc, prisma, audit, invite, current } = makeService();
    const token = await invite();
    await expect(svc.acceptInvite(token, 'Bambu26!')).resolves.toEqual({ ok: true });
    const saved = current();
    expect(saved.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(await bcrypt.compare('Bambu26!', saved.passwordHash)).toBe(true);
    expect(saved).toMatchObject({ invitedAt: null, inviteToken: null });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: OPERATOR } }));
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operator.invite.accepted', tenantId: TENANT, actorId: OPERATOR, targetId: OPERATOR }),
    );
  });

  it('token caducado o falso → 401 y no se cambia nada', async () => {
    const { svc, prisma, invite, expire } = makeService();
    const token = await invite();
    expire(token);
    await expect(svc.acceptInvite(token, 'Bambu2026!')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.acceptInvite('eyJ.falso.firma', 'Bambu2026!')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('token de otro propósito (enlace de onboarding) → 401', async () => {
    const { svc, prisma, invite } = makeService();
    const token = await invite({ sub: OPERATOR, tenantId: TENANT, purpose: 'operator-self-onboarding' });
    await expect(svc.acceptInvite(token, 'Bambu2026!')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('chica dada de baja → 404', async () => {
    const { svc, prisma, invite } = makeService({ user: { deletedAt: new Date('2026-10-15T12:00:00Z') } });
    const token = await invite();
    await expect(svc.acceptInvite(token, 'Bambu2026!')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('token ya usado: la segunda vez → 401 y la contraseña no cambia', async () => {
    const { svc, invite, current } = makeService();
    const token = await invite();
    await svc.acceptInvite(token, 'Bambu2026!');
    const hashAfterFirst = current().passwordHash;
    await expect(svc.acceptInvite(token, 'OtraClave99')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(current().passwordHash).toBe(hashAfterFirst);
  });
});

describe('OperatorsService.regenerateInvite — nuevo enlace de invitación', () => {
  it('rota el token: guarda solo su hash, marca la hora y caduca en 24 h', async () => {
    const { svc, jwt, audit, current } = makeService();
    const res = await svc.regenerateInvite(TENANT, OPERATOR, OWNER);
    const token = res.inviteUrl.split('token=')[1]!;
    expect(res.inviteUrl).toBe(`${APP_URL}/accept-invite?token=${token}`);
    expect(res.expiresAt).toBe(new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString());
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { sub: OPERATOR, tenantId: TENANT, purpose: 'operator-invite' },
      { expiresIn: '24h' },
    );
    expect(current().inviteToken).toBe(sha256(token));
    expect(current().inviteToken).not.toContain(token);
    expect(current().invitedAt).toEqual(NOW);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operator.invite.regenerated', actorId: OWNER, payload: { ttlHours: 24 } }),
    );
  });

  it('el enlace nuevo sirve para activar y el anterior ya no', async () => {
    const { svc, invite } = makeService();
    const oldToken = await invite();
    const { inviteUrl } = await svc.regenerateInvite(TENANT, OPERATOR, OWNER);
    await expect(svc.acceptInvite(oldToken, 'Bambu2026!')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.acceptInvite(inviteUrl.split('token=')[1]!, 'Bambu2026!')).resolves.toEqual({ ok: true });
  });

  it.each([
    ['chica de otro local', { tenantId: OTHER_TENANT }, NotFoundException],
    ['dada de baja', { deletedAt: new Date('2026-10-15T12:00:00Z') }, ConflictException],
    ['ya activó su contraseña (usar resetear)', { invitedAt: null }, ConflictException],
  ])('%s → error y no se firma ni se guarda nada', async (_caso, user, errorClass) => {
    const { svc, jwt, prisma } = makeService({ user });
    await expect(svc.regenerateInvite(TENANT, OPERATOR, OWNER)).rejects.toBeInstanceOf(errorClass);
    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('sin la dirección de la app de las chicas → 503 antes de tocar nada', async () => {
    const { svc, jwt, prisma } = makeService({ noAppUrl: true });
    await expect(svc.regenerateInvite(TENANT, OPERATOR, OWNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('OperatorsService.resetPassword — el dueño le pone una contraseña nueva', () => {
  it('contraseña elegida: se devuelve una vez, se guarda solo su hash y cierra la invitación', async () => {
    const { svc, audit, current } = makeService({ user: { inviteToken: sha256('token-viejo') } });
    const res = await svc.resetPassword(TENANT, OPERATOR, OWNER, 'Lucia.Bambu.26');
    expect(res).toEqual({ password: 'Lucia.Bambu.26', reset: true });
    expect(current().passwordHash).not.toBe('Lucia.Bambu.26');
    expect(await bcrypt.compare('Lucia.Bambu.26', current().passwordHash)).toBe(true);
    expect(current()).toMatchObject({ invitedAt: null, inviteToken: null });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operator.password.reset', actorId: OWNER, targetId: OPERATOR, payload: { explicit: true } }),
    );
  });

  it('sin contraseña (o vacía): genera una de 12 caracteres legibles, distinta cada vez', async () => {
    const first = makeService();
    const a = await first.svc.resetPassword(TENANT, OPERATOR, OWNER, null);
    expect(a.password).toMatch(READABLE_12);
    expect(await bcrypt.compare(a.password, first.current().passwordHash)).toBe(true);
    expect(first.audit.log).toHaveBeenCalledWith(expect.objectContaining({ payload: { explicit: false } }));
    const b = await makeService().svc.resetPassword(TENANT, OPERATOR, OWNER, '');
    expect(b.password).toMatch(READABLE_12);
    expect(b.password).not.toBe(a.password);
  });

  it('contraseña elegida de menos de 8 → 400 sin guardar', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.resetPassword(TENANT, OPERATOR, OWNER, 'corta1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([
    ['chica de otro local', { tenantId: OTHER_TENANT }, NotFoundException],
    ['dada de baja', { deletedAt: new Date('2026-10-15T12:00:00Z') }, ConflictException],
  ])('%s → error sin guardar', async (_caso, user, errorClass) => {
    const { svc, prisma } = makeService({ user });
    await expect(svc.resetPassword(TENANT, OPERATOR, OWNER, 'Lucia.Bambu.26')).rejects.toBeInstanceOf(errorClass);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
