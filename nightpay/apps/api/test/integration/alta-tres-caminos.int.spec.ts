// Integración (Postgres real, FORCE RLS, rol sin superusuario): alta de la compañera con tres
// caminos (migración 20261120500000, 19-nov-2026).
//  - Nombre legal (cifrado, pa1:…) y fecha de nacimiento: por el enlace de alta (solo si aún no
//    estaban; lo guardado lo corrige el dueño) y por el panel; ni en la fila en claro (el nombre)
//    ni en el registro (ninguno de los dos).
//  - Con menos de 18 años no se activa la cuenta: aceptar la invitación, poner contraseña o
//    mandar otra invitación, 403 MINOR_CANNOT_ACTIVATE; si ya entraba, deja de entrar; aviso al
//    dueño en Incidencias. Sin fecha, la compañera no activa (409 BIRTH_DATE_REQUIRED): la pone
//    al activar.
//  - El titular de su IBAN contra su nombre legal: si no coincide, aviso y no se le paga a esa
//    cuenta (ni se pide) hasta que el dueño confirma con su 2FA que es suya; en efectivo, sí. Otro
//    nombre legal vuelve a pedir la confirmación.
//  - OxioCard (OXIOCARD_ENABLED): apagada no existe; encendida, «Abrir mi OxioCard» la deja
//    pedida (una vez), el dueño cambia el estado y ella lo ve. El CHECK de la base y la migración
//    que se puede repetir.
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ClsService } from 'nestjs-cls';
import type { JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AdminController } from '../../src/modules/admin/admin.controller';
import { ApprovalRequestsService } from '../../src/modules/approvals/approval-requests.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { TotpService } from '../../src/modules/auth/totp.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const email = { send: async () => ({ ok: true, delivered: false }) };
const settings: Record<string, unknown> = { OPERATOR_BASE_URL: 'https://personal.example.com', OXIOCARD_ENABLED: false };
const config = {
  get: (k: string) => settings[k],
  getOrThrow: (k: string) => {
    if (settings[k] === undefined) throw new Error(`sin ${k}`);
    return settings[k];
  },
};
const jwt = new JwtService({ secret: 'clave-de-pruebas-del-alta-de-tres-caminos-0123456789' });
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma, new TotpAttemptsService(new LockoutService(redis as never), redis as never));
const sessions = { revokeAllForUser: vi.fn(async () => 0) };
const fx = { getEurToUsdtRateInfo: async () => ({ rate: 1.07, degraded: false }), forMethod: () => ({}) };
const operators = new OperatorsService(prisma, email as never, audit, config as never, jwt, fx as never, sessions as never);
const requests = new ApprovalRequestsService(prisma, audit, config as never, { enabled: () => false, requested: vi.fn() } as never);
const admin = new AdminController(prisma, {} as never, audit, operators, {} as never, cls as never, totp, requests);
const incidents = new IncidentsService(prisma, audit);

function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-alta3-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
function asPublic<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-alta3' });
    return fn();
  });
}
const sys = <T>(fn: Parameters<PrismaService['asSystem']>[0]) => asPublic(() => prisma.asSystem(fn)) as Promise<T>;

async function failure(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpException)) throw new Error(`se esperaba un error HTTP y llegó ${String(err)}`);
  const body = err.getResponse();
  return { status: err.getStatus(), body: typeof body === 'string' ? { message: body } : (body as Record<string, unknown>) };
}

const r = randomUUID().slice(0, 6);
const HOUR = 60 * 60 * 1000;
const IBAN = 'ES9121000418450200051332';
const ADULT = '1998-04-12';
const MINOR = '2010-04-12';
let seq = 0;
const uniq = (p: string) => `${p}-${r}-${++seq}`;

let V: string;
let term: string;
let boss: string;
let manager: string;
let bossSecret: string;

async function newCompanera(name: string, data: Record<string, unknown> = {}): Promise<string> {
  return sys<string>(async (tx) =>
    (
      await tx.user.create({
        data: { tenantId: V, email: `${uniq('comp')}@x.es`, passwordHash: 'hash-de-verdad', role: 'OPERATOR', displayName: name, ...data } as never,
      })
    ).id,
  );
}
async function codeOfBoss(): Promise<string> {
  await totp.forgetUsedCodes(boss);
  return totpCodeAt(bossSecret);
}
const jwtOf = (userId: string, role: 'OWNER' | 'MANAGER') => ({ sub: userId, role, tenantId: V }) as unknown as JwtPayload;
const patch = (userId: string, role: 'OWNER' | 'MANAGER', persona: string, dto: Record<string, unknown>) =>
  asStaff(V, () => admin.updateOperator(V, jwtOf(userId, role), persona, dto as never));
const markPaid = (userId: string, role: 'OWNER' | 'MANAGER', persona: string, dto: Record<string, unknown>) =>
  asStaff(V, () => admin.createOperatorPayout(V, jwtOf(userId, role), persona, dto as never));
/** El enlace de alta del dueño (puede poner su primera cuenta). */
const linkFor = async (persona: string) =>
  (await asStaff(V, () => operators.createSelfOnboardingLink(V, persona, boss, 'OWNER'))).url.split('/onboarding/')[1]!;
const submit = async (persona: string, dto: Record<string, unknown>) => {
  const token = await linkFor(persona);
  return asPublic(() => operators.submitSelfOnboarding(token, dto as never));
};
const rawUser = (id: string) =>
  sys<string>(async (tx) => (await tx.$queryRaw<Array<{ j: string }>>`SELECT row_to_json(u)::text AS j FROM users u WHERE u.id = ${id}::uuid`)[0]!.j);
const row = (id: string) =>
  sys<{
    legalName: string | null;
    birthDate: Date | null;
    invitedAt: Date | null;
    inviteToken: string | null;
    passwordHash: string;
    onboardingStatus: string;
    payoutHolderConfirmedAt: Date | null;
    oxiocardStatus: string;
    oxiocardStatusAt: Date | null;
  }>((tx) => tx.user.findUniqueOrThrow({ where: { id } }) as never);
const auditOf = (targetId: string) =>
  sys<Array<{ action: string; payload: Record<string, unknown> | null }>>((tx) =>
    tx.auditEvent.findMany({ where: { targetId }, orderBy: { id: 'asc' }, select: { action: true, payload: true } }),
  );
const viewOf = async (persona: string) => (await asStaff(V, () => operators.listVenueOperators(V))).find((o) => o.id === persona)!;
async function newEarning(persona: string, amountCents: number): Promise<void> {
  await sys(async (tx) => {
    const at = new Date(Date.now() - 2 * HOUR);
    const p = await tx.payment.create({
      data: {
        tenantId: V, terminalId: term, idempotencyKey: uniq('k'), qrToken: uniq('q'), qrExpiresAt: new Date(Date.now() + HOUR),
        status: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: uniq('PT'), amountCents, availableAmountCents: amountCents,
        createdByUserId: persona, revenueCategory: 'CHICA_SERVICE', authorizedAt: at, createdAt: at, cardLast4: '4242', cardBrand: 'VISA',
      } as never,
    });
    await tx.operatorEarning.create({
      data: { tenantId: V, operatorId: persona, paymentId: p.id, paymentAmountCents: amountCents, commissionBps: 9000, commissionCents: Math.round(amountCents * 0.9), createdAt: at },
    });
  });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ V, term } = await sys<{ V: string; term: string }>(async (tx) => {
    const v = await tx.venue.create({ data: { name: `Sala Alta ${r}`, slug: `alta3-${r}`, payoutHoldDays: 0 } });
    const t = await tx.terminal.create({ data: { tenantId: v.id, externalId: `A3-${r}`, label: 'Barra' } });
    return { V: v.id, term: t.id };
  }));
  bossSecret = totp.newSecret();
  boss = await sys<string>(async (tx) =>
    (await tx.user.create({ data: { tenantId: V, email: `${uniq('boss')}@x.es`, passwordHash: 'x', role: 'OWNER', displayName: 'Javi', totpSecret: totp.sealSecret(bossSecret) } })).id,
  );
  manager = await sys<string>(async (tx) =>
    (await tx.user.create({ data: { tenantId: V, email: `${uniq('enc')}@x.es`, passwordHash: 'x', role: 'MANAGER', displayName: 'Marta' } })).id,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('nombre legal y fecha de nacimiento', () => {
  it('por el enlace: el nombre queda cifrado, la fecha guardada y el registro sin ninguno de los dos', async () => {
    const ana = await newCompanera('Lola');
    await expect(submit(ana, { legalName: 'Ana María López Pérez', birthDate: ADULT })).resolves.toEqual({ ok: true });
    const saved = await row(ana);
    expect(saved.legalName).toMatch(/^pa1:/);
    expect(saved.birthDate?.toISOString().slice(0, 10)).toBe(ADULT);
    expect(await rawUser(ana)).not.toContain('López');
    const logged = JSON.stringify(await auditOf(ana));
    expect(logged).not.toContain('López');
    expect(logged).not.toContain(ADULT);
    // El panel: tapado y la fecha.
    expect(await viewOf(ana)).toMatchObject({ legalNameMasked: 'A••• M••• L••• P•••', birthDate: ADULT, payoutHolderUnconfirmed: false });
  });

  it('por el panel (solo el dueño): igual, y en el registro tapado', async () => {
    const bea = await newCompanera('Bea');
    await patch(boss, 'OWNER', bea, { legalName: 'Beatriz Ruiz', birthDate: ADULT });
    expect((await row(bea)).legalName).toMatch(/^pa1:/);
    const [updated] = await auditOf(bea);
    expect(updated).toMatchObject({ action: 'operator.updated', payload: { changes: { legalName: 'B••• R•••', birthDate: 'cambiada' } } });
    expect(await failure(patch(manager, 'MANAGER', bea, { legalName: 'Otra Persona' }))).toMatchObject({ status: 403 });
  });
});

describe('menor de 18 años: no activa la cuenta y se avisa al dueño', () => {
  it('ya entraba y pone una fecha de menor en el alta: deja de entrar, sesiones fuera y aviso en Incidencias', async () => {
    const cris = await newCompanera('Cris');
    sessions.revokeAllForUser.mockClear();
    await expect(submit(cris, { birthDate: MINOR })).resolves.toEqual({ ok: true, minor: true });
    const saved = await row(cris);
    expect(saved).toMatchObject({ inviteToken: null, onboardingStatus: 'BLOCKED' });
    expect(saved.invitedAt).toBeInstanceOf(Date);
    expect(saved.passwordHash).not.toBe('hash-de-verdad');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(cris);

    const inbox = await asStaff(V, () => incidents.list(V));
    const notice = inbox.find((i) => i.title === 'Menor de edad: cuenta sin activar');
    expect(notice?.detail).toContain('(Cris)');
    expect(JSON.stringify(inbox)).not.toContain(MINOR);
    expect(JSON.stringify(await auditOf(cris))).not.toContain(MINOR);
  });

  it('con una invitación de antes no activa; ni contraseña nueva ni otra invitación', async () => {
    const dani = await newCompanera('Dani', { invitedAt: new Date() });
    const token = await jwt.signAsync({ sub: dani, tenantId: V, purpose: 'operator-invite' }, { expiresIn: '24h' });
    await sys((tx) =>
      tx.user.update({
        where: { id: dani },
        data: { inviteToken: createHash('sha256').update(token).digest('hex'), birthDate: new Date(`${MINOR}T00:00:00Z`) } as never,
      }),
    );
    const refused = { status: 403, body: { code: 'MINOR_CANNOT_ACTIVATE' } };
    expect(await failure(asPublic(() => operators.acceptInvite(token, 'contraseña-larga')))).toMatchObject(refused);
    expect((await row(dani)).invitedAt).toBeInstanceOf(Date);
    expect(await failure(asStaff(V, () => operators.resetPassword(V, dani, boss, null)))).toMatchObject(refused);
    expect(await failure(asStaff(V, () => operators.regenerateInvite(V, dani, boss)))).toMatchObject(refused);
  });

  it('una fecha ya guardada no se cambia por el enlace: la menor bloqueada sigue bloqueada aunque ponga otra', async () => {
    const lia = await newCompanera('Lia');
    await submit(lia, { birthDate: MINOR });
    await expect(submit(lia, { birthDate: ADULT })).resolves.toEqual({ ok: true });
    const saved = await row(lia);
    expect(saved.birthDate?.toISOString().slice(0, 10)).toBe(MINOR);
    expect(saved.onboardingStatus).toBe('BLOCKED');
    expect(await failure(asStaff(V, () => operators.regenerateInvite(V, lia, manager)))).toMatchObject({ status: 403, body: { code: 'MINOR_CANNOT_ACTIVATE' } });
    const submitted = (await auditOf(lia)).filter((a) => a.action === 'operator.self_onboarding.submitted');
    expect(submitted.at(-1)?.payload).toMatchObject({ identityIgnored: ['birthDate'] });
    expect(JSON.stringify(submitted)).not.toContain(ADULT);
  });

  it('el dueño pone una fecha de menor en el panel: lo mismo; si la corrige, vuelve a poder invitarla', async () => {
    const eva = await newCompanera('Eva');
    await patch(boss, 'OWNER', eva, { birthDate: MINOR });
    expect(await row(eva)).toMatchObject({ onboardingStatus: 'BLOCKED', inviteToken: null });
    expect((await auditOf(eva)).map((a) => a.action)).toContain('operator.minor_blocked');
    await patch(boss, 'OWNER', eva, { birthDate: ADULT });
    await expect(asStaff(V, () => operators.regenerateInvite(V, eva, boss))).resolves.toMatchObject({ inviteUrl: expect.any(String) });
  });
});

describe('sin fecha de nacimiento, la compañera no activa la cuenta', () => {
  const inviteFor = async (persona: string) => {
    const token = await jwt.signAsync({ sub: persona, tenantId: V, purpose: 'operator-invite' }, { expiresIn: '24h' });
    await sys((tx) =>
      tx.user.update({ where: { id: persona }, data: { invitedAt: new Date(), inviteToken: createHash('sha256').update(token).digest('hex') } }),
    );
    return token;
  };

  it('sin fecha: 409 y sigue pendiente; la pone al activar, entra y queda guardada', async () => {
    const noa = await newCompanera('Noa');
    const token = await inviteFor(noa);
    expect(await failure(asPublic(() => operators.acceptInvite(token, 'contraseña-larga')))).toMatchObject({ status: 409, body: { code: 'BIRTH_DATE_REQUIRED' } });
    expect((await row(noa)).invitedAt).toBeInstanceOf(Date);
    await expect(asPublic(() => operators.acceptInvite(token, 'contraseña-larga', ADULT))).resolves.toEqual({ ok: true });
    const saved = await row(noa);
    expect(saved.invitedAt).toBeNull();
    expect(saved.birthDate?.toISOString().slice(0, 10)).toBe(ADULT);
  });

  it('pone una fecha de menor al activar: no entra, queda bloqueada, la invitación ya no vale y el dueño lo ve', async () => {
    const ona = await newCompanera('Ona');
    const token = await inviteFor(ona);
    expect(await failure(asPublic(() => operators.acceptInvite(token, 'contraseña-larga', MINOR)))).toMatchObject({ status: 403, body: { code: 'MINOR_CANNOT_ACTIVATE' } });
    expect(await row(ona)).toMatchObject({ onboardingStatus: 'BLOCKED', inviteToken: null });
    expect(await failure(asPublic(() => operators.acceptInvite(token, 'contraseña-larga', ADULT)))).toMatchObject({ status: 401 });
    const inbox = await asStaff(V, () => incidents.list(V));
    expect(inbox.some((i) => i.title === 'Menor de edad: cuenta sin activar' && i.detail.includes('(Ona)'))).toBe(true);
    expect(JSON.stringify(await auditOf(ona))).not.toContain(MINOR);
  });
});

describe('el titular de su IBAN contra su nombre legal', () => {
  let flor: string;

  it('por el enlace, con otro titular: aviso en Incidencias de que hay que confirmarla', async () => {
    flor = await newCompanera('Flor');
    await submit(flor, {
      legalName: 'Florencia Díaz',
      birthDate: ADULT,
      payoutMethod: 'SEPA_IBAN',
      payoutAddress: IBAN,
      payoutMetadata: { accountHolder: 'Pedro Gómez' },
    });
    const changed = (await auditOf(flor)).find((a) => a.action === 'operator.payout_account_changed');
    expect(changed?.payload).toMatchObject({ via: 'enlace', holderMismatch: true, holderToConfirm: true });
    const inbox = await asStaff(V, () => incidents.list(V));
    expect(inbox.find((i) => i.detail.includes('(Flor)'))?.detail).toContain('no coincide con su nombre legal');
    expect(await viewOf(flor)).toMatchObject({ payoutHolderMismatch: true, payoutHolderUnconfirmed: true });
  });

  it('no se le paga a esa cuenta ni se pide; en efectivo, sí', async () => {
    await newEarning(flor, 10_000);
    const res = await failure(markPaid(boss, 'OWNER', flor, { externalRail: 'SEPA_IBAN', totpCode: await codeOfBoss() }));
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_HOLDER_UNCONFIRMED' } });
    expect(await failure(markPaid(manager, 'MANAGER', flor, { externalRail: 'SEPA_IBAN' }))).toMatchObject({ status: 409, body: { code: 'PAYOUT_HOLDER_UNCONFIRMED' } });
    await expect(markPaid(boss, 'OWNER', flor, { externalRail: 'MANUAL_CASH', totpCode: await codeOfBoss() })).resolves.toMatchObject({ totalCents: 9000 });
  });

  it('el dueño confirma con su 2FA que es suya: ya se le paga; otro nombre legal lo vuelve a pedir', async () => {
    expect(await failure(patch(boss, 'OWNER', flor, { payoutHolderConfirmed: true }))).toMatchObject({ status: 403 });
    await patch(boss, 'OWNER', flor, { payoutHolderConfirmed: true, totpCode: await codeOfBoss() });
    expect((await row(flor)).payoutHolderConfirmedAt).toBeInstanceOf(Date);
    await newEarning(flor, 20_000);
    await expect(markPaid(boss, 'OWNER', flor, { externalRail: 'SEPA_IBAN', totpCode: await codeOfBoss() })).resolves.toMatchObject({ totalCents: 18000 });

    await patch(boss, 'OWNER', flor, { legalName: 'Florencia Díaz Ruiz' });
    expect(await viewOf(flor)).toMatchObject({ payoutHolderUnconfirmed: true });
    // El mismo nombre otra vez no la vuelve a pedir.
    await patch(boss, 'OWNER', flor, { payoutHolderConfirmed: true, totpCode: await codeOfBoss() });
    await patch(boss, 'OWNER', flor, { legalName: 'Florencia Díaz Ruiz' });
    expect(await viewOf(flor)).toMatchObject({ payoutHolderUnconfirmed: false });
  });

  it('otra cuenta con el mismo titular: la confirmación era para la de antes', async () => {
    await patch(boss, 'OWNER', flor, { payoutAddress: 'ES7921000813610123456789', totpCode: await codeOfBoss() });
    expect(await viewOf(flor)).toMatchObject({ payoutHolderUnconfirmed: true });
    expect((await row(flor)).payoutHolderConfirmedAt).toBeNull();
  });

  it('el enlace no cambia un nombre legal ya guardado: igualarlo al titular no se salta la confirmación del dueño', async () => {
    const mia = await newCompanera('Mia');
    await submit(mia, { legalName: 'Mía Soler', birthDate: ADULT, payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutMetadata: { accountHolder: 'Pedro Gómez' } });
    await expect(submit(mia, { legalName: 'Pedro Gómez' })).resolves.toEqual({ ok: true });
    expect(await viewOf(mia)).toMatchObject({ legalNameMasked: 'M••• S•••', payoutHolderUnconfirmed: true });
    await newEarning(mia, 10_000);
    const res = await failure(markPaid(boss, 'OWNER', mia, { externalRail: 'SEPA_IBAN', totpCode: await codeOfBoss() }));
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_HOLDER_UNCONFIRMED' } });
  });

  it('con el titular que coincide no hay nada que confirmar', async () => {
    const gema = await newCompanera('Gema');
    await submit(gema, { legalName: 'Gema Torres', birthDate: ADULT, payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutMetadata: { accountHolder: 'GEMA TORRES SANZ' } });
    expect(await viewOf(gema)).toMatchObject({ payoutHolderMismatch: false, payoutHolderUnconfirmed: false });
  });
});

describe('OxioCard (OXIOCARD_ENABLED)', () => {
  it('apagada: no sale, su ruta no existe y el dueño no la cambia', async () => {
    settings.OXIOCARD_ENABLED = false;
    const hana = await newCompanera('Hana');
    expect(await failure(asStaff(V, () => operators.requestMyOxiocard(hana, V)))).toMatchObject({ status: 404 });
    expect(await failure(patch(boss, 'OWNER', hana, { oxiocardStatus: 'APROBADA' }))).toMatchObject({ status: 400 });
    expect(await viewOf(hana)).not.toHaveProperty('oxiocardStatus');
    expect((await asStaff(V, () => operators.getMyPayoutInfo(hana, V))).oxiocard).toBeNull();
  });

  it('encendida: «Abrir mi OxioCard» la deja pedida una vez, el dueño la aprueba y ella lo ve', async () => {
    settings.OXIOCARD_ENABLED = 'true';
    const ines = await newCompanera('Inés');
    const [a, b] = await Promise.all([
      asStaff(V, () => operators.requestMyOxiocard(ines, V)),
      asStaff(V, () => operators.requestMyOxiocard(ines, V)),
    ]);
    expect([a.status, b.status]).toEqual(['SOLICITADA', 'SOLICITADA']);
    expect((await auditOf(ines)).filter((x) => x.action === 'operator.oxiocard_requested')).toHaveLength(1);
    expect(await viewOf(ines)).toMatchObject({ oxiocardStatus: 'SOLICITADA' });

    await patch(boss, 'OWNER', ines, { oxiocardStatus: 'APROBADA' });
    expect((await asStaff(V, () => operators.getMyPayoutInfo(ines, V))).oxiocard).toMatchObject({ status: 'APROBADA', at: expect.any(String) });
    expect(await failure(patch(manager, 'MANAGER', ines, { oxiocardStatus: 'RECHAZADA' }))).toMatchObject({ status: 403 });

    const juli = await newCompanera('Juli');
    await submit(juli, { oxiocard: true });
    expect((await row(juli)).oxiocardStatus).toBe('SOLICITADA');
    settings.OXIOCARD_ENABLED = false;
  });

  it('la base no admite un estado inventado', async () => {
    const kia = await newCompanera('Kia');
    await expect(sys((tx) => tx.$executeRaw`UPDATE users SET "oxiocardStatus" = 'ENVIADA' WHERE id = ${kia}::uuid`)).rejects.toThrow();
    expect((await row(kia)).oxiocardStatus).toBe('NO_SOLICITADA');
  });
});

describe('la migración 20261120500000_alta_tres_caminos', () => {
  const sql = readFileSync(
    join(__dirname, '../../../../packages/db/prisma/migrations/20261120500000_alta_tres_caminos/migration.sql'),
    'utf8',
  );
  /** Sentencias sin comentarios; los bloques DO $$ … $$ enteros. */
  const statements = (text: string): string[] => {
    const out: string[] = [];
    let current = '';
    let inBlock = false;
    for (const line of text.split('\n').filter((l) => !l.trim().startsWith('--'))) {
      current += `${line}\n`;
      if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inBlock = !inBlock;
      if (!inBlock && line.trim().endsWith(';')) {
        out.push(current.trim());
        current = '';
      }
    }
    return out.filter(Boolean);
  };

  it('empieza con su lock_timeout, no borra nada y se puede repetir', async () => {
    expect(sql).toMatch(/^SET lock_timeout = '5s';$/m);
    expect(sql).not.toMatch(/DROP |TRUNCATE|DELETE FROM/i);
    const before = await sys<number>((tx) => tx.user.count());
    for (const st of statements(sql)) await sys((tx) => tx.$executeRawUnsafe(st));
    await sys((tx) => tx.$executeRawUnsafe('RESET lock_timeout'));
    expect(await sys<number>((tx) => tx.user.count())).toBe(before);
  });
});
