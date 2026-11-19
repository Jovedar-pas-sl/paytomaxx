import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import {
  CreateStallSchema,
  EVENT_ENDED_CODE,
  LoginResponseSchema,
  SetMyStallOpenSchema,
  StallIbanSchema,
  UpdatePartySettingsSchema,
  UpdateStallSchema,
  isEventEnded,
  parseEdition,
  partySettingsProblem,
  stallChangeTouchesMoney,
} from '@nightpay/contracts';
import { currentEdition, isPartyEdition } from '../../config/edition';
import { parseEnv } from '../../config/env';
import { EventEndedException, assertEventNotEnded, assertEventOpen } from './event-window';
import { PartyEditionGuard } from './party-edition.guard';
import { PartyModule } from './party.module';
import { myStall, stallIdForStaff, stallSeal } from './stall-seal';

/** OxioParty: la edición, las reglas de contracts y los ayudantes que usan los cobros. */

afterEach(() => {
  vi.unstubAllEnvs();
});

const party = () => vi.stubEnv('EDITION', 'party');
const IBAN = 'ES9121000418450200051332';

describe('la edición', () => {
  it('sin EDITION, o con cualquier cosa que no sea party, es OxioPay (club)', () => {
    expect(parseEdition(undefined)).toBe('club');
    expect(parseEdition('')).toBe('club');
    expect(parseEdition('fiesta')).toBe('club');
    expect(parseEdition(' Party ')).toBe('party');
    expect(currentEdition({})).toBe('club');
    expect(currentEdition({ EDITION: 'party' })).toBe('party');
    expect(isPartyEdition({ EDITION: 'club' })).toBe(false);
  });

  it('env.ts: club por defecto, party vale y una errata no arranca', () => {
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'j'.repeat(40),
      COOKIE_SECRET: 'c'.repeat(40),
      ENCRYPTION_KEK: 'k'.repeat(40),
      PEANPE_API_URL: 'https://peanpe.invalid/api',
      PEANPE_WEBHOOK_SECRET: 'secreto-peanpe',
    };
    expect(parseEnv(base).EDITION).toBe('club');
    expect(parseEnv({ ...base, EDITION: 'party' }).EDITION).toBe('party');
    expect(() => parseEnv({ ...base, EDITION: 'fiesta' })).toThrow(/EDITION/);
  });

  it('el login la lleva (opcional: los API de antes no la mandan)', () => {
    const user = { id: '00000000-0000-4000-8000-000000000001', email: 'a@b.es', role: 'WAITER', tenantId: '00000000-0000-4000-8000-0000000000aa', venueSlug: 'x', displayName: null };
    const res = { accessToken: 't', expiresIn: 60, refreshExpiresIn: 60, user };
    expect(LoginResponseSchema.parse(res).user.edition).toBeUndefined();
    expect(LoginResponseSchema.parse({ ...res, user: { ...user, edition: 'party' } }).user.edition).toBe('party');
  });

  it('las rutas de la fiesta: 404 con club, abiertas con party', () => {
    const guard = new PartyEditionGuard();
    expect(() => guard.canActivate()).toThrow(NotFoundException);
    party();
    expect(guard.canActivate()).toBe(true);
  });

  it('todos los controladores del módulo de la fiesta llevan esa guarda (también «Abierta ahora»)', () => {
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PartyModule) as Array<new (...args: never[]) => unknown>;
    expect(controllers.map((c) => c.name)).toContain('MyStallController');
    for (const c of controllers) expect(Reflect.getMetadata(GUARDS_METADATA, c), c.name).toContain(PartyEditionGuard);
  });
});

describe('casetas (contracts)', () => {
  it('el IBAN se guarda sin espacios y en mayúsculas, y con el dígito de control bueno', () => {
    expect(StallIbanSchema.parse('es91 2100 0418 4502 0005 1332')).toBe(IBAN);
    expect(StallIbanSchema.safeParse('ES9221000418450200051332').success).toBe(false);
    expect(StallIbanSchema.safeParse('no es un iban').success).toBe(false);
  });

  it('la parte del organizador, de 0 a 10000 y entera (10000 = barra propia)', () => {
    const base = { name: 'Peña El Trago', managerName: 'Lola' };
    for (const organizerBps of [0, 2500, 10_000]) expect(CreateStallSchema.safeParse({ ...base, organizerBps }).success).toBe(true);
    for (const organizerBps of [-1, 10_001, 25.5]) expect(CreateStallSchema.safeParse({ ...base, organizerBps }).success).toBe(false);
    expect(CreateStallSchema.safeParse({ name: 'Sin responsable', organizerBps: 0 }).success).toBe(false);
    expect(CreateStallSchema.safeParse({ ...base, organizerBps: 0, name: '   ' }).success).toBe(false);
  });

  it('la lista del asistente: zona (60) y qué vende (120), sin espacios sueltos; «Abierta ahora», sí o no', () => {
    const base = { name: 'Peña El Trago', managerName: 'Lola', organizerBps: 0 };
    expect(CreateStallSchema.parse({ ...base, zone: '  Junto al escenario ', sells: ' Bocadillos, cerveza ', openNow: true })).toMatchObject({
      zone: 'Junto al escenario',
      sells: 'Bocadillos, cerveza',
      openNow: true,
    });
    expect(CreateStallSchema.safeParse({ ...base, zone: 'x'.repeat(60), sells: 'x'.repeat(120) }).success).toBe(true);
    expect(CreateStallSchema.safeParse({ ...base, zone: 'x'.repeat(61) }).success).toBe(false);
    expect(CreateStallSchema.safeParse({ ...base, sells: 'x'.repeat(121) }).success).toBe(false);
    expect(UpdateStallSchema.safeParse({ zone: '   ' }).success).toBe(false);
    expect(UpdateStallSchema.safeParse({ zone: null, sells: null }).success).toBe(true);
    expect(UpdateStallSchema.safeParse({ openNow: 'sí' }).success).toBe(false);
    expect(UpdateStallSchema.safeParse({ openNow: false }).success).toBe(true);
    expect(stallChangeTouchesMoney({ zone: 'Plaza', openNow: true } as never)).toBe(false);
    expect(SetMyStallOpenSchema.safeParse({ openNow: true }).success).toBe(true);
    for (const bad of [{}, { openNow: 'true' }, { openNow: null }]) expect(SetMyStallOpenSchema.safeParse(bad).success).toBe(false);
  });

  it('cambiar sin nada que cambiar no vale; el 2FA solo cuando toca dinero', () => {
    expect(UpdateStallSchema.safeParse({}).success).toBe(false);
    expect(UpdateStallSchema.safeParse({ totpCode: '123456' }).success).toBe(false);
    expect(UpdateStallSchema.safeParse({ name: 'Nueva' }).success).toBe(true);
    expect(stallChangeTouchesMoney({ organizerBps: 0 })).toBe(true);
    expect(stallChangeTouchesMoney({ iban: null })).toBe(true);
    expect(stallChangeTouchesMoney({})).toBe(false);
  });
});

describe('ajustes de la fiesta (contracts)', () => {
  it('fechas con zona, día AAAA-MM-DD que exista y umbral en su rango', () => {
    expect(UpdatePartySettingsSchema.safeParse({ eventEndsAt: '2026-03-20T06:00:00+01:00' }).success).toBe(true);
    expect(UpdatePartySettingsSchema.safeParse({ eventEndsAt: '2026-03-20 06:00' }).success).toBe(false);
    expect(UpdatePartySettingsSchema.safeParse({ refundDeadline: '2026-04-30' }).success).toBe(true);
    expect(UpdatePartySettingsSchema.safeParse({ refundDeadline: '2026-02-30' }).success).toBe(false);
    expect(UpdatePartySettingsSchema.safeParse({ cashAlertCents: -1 }).success).toBe(false);
    expect(UpdatePartySettingsSchema.safeParse({ eventEndsAt: null }).success).toBe(true);
    expect(UpdatePartySettingsSchema.safeParse({}).success).toBe(false);
  });

  it('el fin, después del inicio', () => {
    expect(partySettingsProblem({ eventStartsAt: '2026-03-15T10:00:00Z', eventEndsAt: '2026-03-15T09:00:00Z' })).toMatch(/después/);
    expect(partySettingsProblem({ eventStartsAt: '2026-03-15T10:00:00Z', eventEndsAt: '2026-03-15T10:00:00Z' })).not.toBeNull();
    expect(partySettingsProblem({ eventStartsAt: '2026-03-15T10:00:00Z', eventEndsAt: '2026-03-20T06:00:00Z' })).toBeNull();
    expect(partySettingsProblem({ eventStartsAt: null, eventEndsAt: '2026-03-20T06:00:00Z' })).toBeNull();
  });

  it('terminada: el fin ya pasó (sin fin, nunca)', () => {
    const now = new Date('2026-03-20T06:00:00Z');
    expect(isEventEnded(new Date('2026-03-20T06:00:00Z'), now)).toBe(true);
    expect(isEventEnded('2026-03-20T05:59:59Z', now)).toBe(true);
    expect(isEventEnded('2026-03-20T06:00:01Z', now)).toBe(false);
    expect(isEventEnded(null, now)).toBe(false);
    expect(isEventEnded('no es una fecha', now)).toBe(false);
  });
});

describe('EVENT_ENDED: sin cobros ni recargas nuevos al terminar (solo OxioParty)', () => {
  const ended = { eventEndsAt: new Date(Date.now() - 60_000) };
  const later = { eventEndsAt: new Date(Date.now() + 3_600_000) };

  it('OxioPay (club): nunca, y sin mirar la base', async () => {
    expect(() => assertEventNotEnded(ended)).not.toThrow();
    const db = { venue: { findUnique: vi.fn() } };
    await assertEventOpen(db as never, 'v-1');
    expect(db.venue.findUnique).not.toHaveBeenCalled();
  });

  it('OxioParty: con el fin pasado, 423 EVENT_ENDED con un mensaje claro', async () => {
    party();
    const db = { venue: { findUnique: vi.fn().mockResolvedValue(ended) } };
    const err = await assertEventOpen(db as never, 'v-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventEndedException);
    expect((err as EventEndedException).getStatus()).toBe(423);
    expect((err as EventEndedException).getResponse()).toMatchObject({ code: EVENT_ENDED_CODE, message: expect.stringMatching(/ya ha terminado/) });
    expect(db.venue.findUnique).toHaveBeenCalledWith({ where: { id: 'v-1' }, select: { eventEndsAt: true } });
  });

  it('OxioParty: antes del fin, sin fecha de fin o sin local, se cobra', async () => {
    party();
    for (const venue of [later, { eventEndsAt: null }, null]) {
      const db = { venue: { findUnique: vi.fn().mockResolvedValue(venue) } };
      await expect(assertEventOpen(db as never, 'v-1')).resolves.toBeUndefined();
    }
  });
});

describe('la caseta en el cobro (sellado)', () => {
  it('OxioPay: null sin mirar la base, y el data de Prisma no cambia', async () => {
    const db = { user: { findFirst: vi.fn() } };
    expect(await stallIdForStaff(db as never, { tenantId: 't-1', userId: 'u-1' })).toBeNull();
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(stallSeal(null)).toEqual({});
    expect(stallSeal(undefined)).toEqual({});
    expect(stallSeal('s-1')).toEqual({ stallId: 's-1' });
  });

  it('OxioParty: la caseta de la persona, solo si es de ese local; sin persona, ninguna', async () => {
    party();
    const db = { user: { findFirst: vi.fn().mockResolvedValue({ stallId: 's-1' }) } };
    expect(await stallIdForStaff(db as never, { tenantId: 't-1', userId: 'u-1' })).toBe('s-1');
    expect(db.user.findFirst).toHaveBeenCalledWith({ where: { id: 'u-1', tenantId: 't-1' }, select: { stallId: true } });
    expect(await stallIdForStaff(db as never, { tenantId: 't-1', userId: null })).toBeNull();
    db.user.findFirst.mockResolvedValueOnce(null);
    expect(await stallIdForStaff(db as never, { tenantId: 't-2', userId: 'u-1' })).toBeNull();
  });

  it('«me»: la caseta corta dentro de withTenant (FORCE RLS); OxioPay, null sin mirar', async () => {
    const tx = { user: { findFirst: vi.fn().mockResolvedValue({ stall: { id: 's-1', name: 'Peña El Trago' } }) } };
    const prisma = { withTenant: vi.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)) };
    expect(await myStall(prisma as never, { tenantId: 't-1', userId: 'u-1' })).toBeNull();
    expect(prisma.withTenant).not.toHaveBeenCalled();
    party();
    expect(await myStall(prisma as never, { tenantId: 't-1', userId: 'u-1' })).toEqual({ id: 's-1', name: 'Peña El Trago' });
    expect(prisma.withTenant).toHaveBeenCalledWith('t-1', expect.any(Function));
    tx.user.findFirst.mockResolvedValueOnce({ stall: null });
    expect(await myStall(prisma as never, { tenantId: 't-1', userId: 'u-1' })).toBeNull();
  });
});
