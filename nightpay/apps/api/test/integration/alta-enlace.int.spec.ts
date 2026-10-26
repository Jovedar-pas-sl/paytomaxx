// Integración (Postgres real, FORCE RLS, TENANCY_UNSCOPED_QUERIES=throw): el enlace de alta de la chica.
//  - Es de un solo uso: al guardar queda «usado» (users.selfOnboardingToken = used:<hash>).
//  - El mismo enlace otra vez (la respuesta se perdió, o lo vuelve a abrir): 409 «ya se guardaron
//    tus datos», sin tocar nada; dos «Guardar» a la vez guardan una sola vez.
//  - Un enlace nuevo del admin pisa la marca y el viejo pasa a ser inválido (401).
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: async () => undefined };
const config = {
  get: (k: string) => (k === 'OPERATOR_BASE_URL' ? 'https://chicas.example.com' : undefined),
  getOrThrow: (k: string) => {
    throw new Error(`sin ${k}`);
  },
};
const jwt = new JwtService({ secret: 'clave-de-pruebas-del-enlace-de-alta-0123456789' });
const operators = new OperatorsService(prisma, audit as never, audit as never, config as never, jwt, {} as never, {} as never);

const r = randomUUID().slice(0, 6);
const IBAN = 'ES9121000418450200051332';
let venueId: string;
let ownerId: string;

/** Como la petición de la chica: sin local ni sesión en el contexto. */
function publicCall<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-alta' });
    return fn();
  });
}
function inVenue<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-alta-panel', tenantId: venueId });
    return fn();
  });
}
function seed<T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-seed' });
    return prisma.asSystem(fn);
  });
}

async function newOperator(tag: string): Promise<string> {
  return seed(async (tx) =>
    (await tx.user.create({
      data: { tenantId: venueId, email: `chica-${tag}-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: `Chica ${tag}` } as never,
    })).id,
  );
}
async function linkFor(operatorId: string): Promise<string> {
  const link = await inVenue(() => operators.createSelfOnboardingLink(venueId, operatorId, ownerId, 'OWNER'));
  return link.url.split('/onboarding/')[1]!;
}
async function stored(operatorId: string) {
  return seed((tx) =>
    tx.user.findUniqueOrThrow({ where: { id: operatorId }, select: { phone: true, payoutAddress: true, selfOnboardingToken: true } }),
  );
}
const alreadySaved = { response: expect.objectContaining({ code: 'SELF_ONBOARDING_ALREADY_SAVED' }) };

beforeAll(async () => {
  await prisma.$connect();
  await seed(async (tx) => {
    venueId = (await tx.venue.create({ data: { name: `Alta ${r}`, slug: `alta-${r}` } })).id;
    ownerId = (await tx.user.create({ data: { tenantId: venueId, email: `owner-alta-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } as never })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('el enlace de alta: un solo uso, y si se perdió la respuesta se sabe que ya se guardó (Postgres real)', () => {
  it('guarda una vez; el mismo enlace otra vez dice «ya se guardó» (GET y POST) y no cambia nada', async () => {
    const op = await newOperator('a');
    const token = await linkFor(op);
    await expect(publicCall(() => operators.getSelfOnboardingProfile(token))).resolves.toMatchObject({ canSetPayout: true });
    await expect(
      publicCall(() => operators.submitSelfOnboarding(token, { phone: '600000000', payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN })),
    ).resolves.toEqual({ ok: true });
    const after = await stored(op);
    expect(after).toMatchObject({ phone: '600000000', payoutAddress: IBAN });
    expect(after.selfOnboardingToken).toMatch(/^used:[0-9a-f]{64}$/);

    // La respuesta se perdió y reintenta (aunque cambie algo): ya está guardado, no se vuelve a guardar.
    const retry = publicCall(() => operators.submitSelfOnboarding(token, { phone: '611111111' }));
    await expect(retry).rejects.toBeInstanceOf(ConflictException);
    await expect(publicCall(() => operators.submitSelfOnboarding(token, { phone: '611111111' }))).rejects.toMatchObject(alreadySaved);
    await expect(publicCall(() => operators.getSelfOnboardingProfile(token))).rejects.toMatchObject(alreadySaved);
    expect(await stored(op)).toMatchObject({ phone: '600000000' });
  });

  it('dos «Guardar» a la vez con el mismo enlace: uno guarda y el otro dice «ya se guardó»', async () => {
    const op = await newOperator('b');
    const token = await linkFor(op);
    const results = await Promise.allSettled([
      publicCall(() => operators.submitSelfOnboarding(token, { phone: '622222222' })),
      publicCall(() => operators.submitSelfOnboarding(token, { phone: '633333333' })),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject(alreadySaved);
    const winner = (await stored(op)).phone;
    expect(['622222222', '633333333']).toContain(winner);
  });

  it('un enlace nuevo del admin vale otra vez; el usado de antes pasa a ser inválido (401)', async () => {
    const op = await newOperator('c');
    const first = await linkFor(op);
    await publicCall(() => operators.submitSelfOnboarding(first, { phone: '644444444' }));
    // jwt firma por segundos: el enlace nuevo, otro segundo (si no, sería el mismo).
    await new Promise((done) => setTimeout(done, 1_100));
    const second = await linkFor(op);
    expect(second).not.toBe(first);
    await expect(publicCall(() => operators.getSelfOnboardingProfile(first))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(publicCall(() => operators.submitSelfOnboarding(second, { phone: '655555555' }))).resolves.toEqual({ ok: true });
    expect(await stored(op)).toMatchObject({ phone: '655555555' });
  });
});
