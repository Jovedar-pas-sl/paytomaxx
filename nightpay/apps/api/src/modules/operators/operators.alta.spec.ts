import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MINOR_CANNOT_ACTIVATE } from '@nightpay/contracts';
import { OperatorsService } from './operators.service';
import { birthDateValue, sealLegalName } from './alta-identity';
import { sealPayoutValue } from './payout-account-crypto';

// Alta con tres caminos (19-nov-2026) en el servicio, con la base de mentira:
// nombre legal y fecha (menor → sin acceso y aviso), «la cuenta es suya» y la
// OxioCard. Lo de la base de verdad: test/integration/alta-tres-caminos.int.spec.ts.

process.env.ENCRYPTION_KEK ??= 'clave-de-pruebas-del-alta-0123456789-abcdef';
const TOKEN = 'header.payload.signature-token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const ADULT = '1998-04-12';
const MINOR = '2010-04-12';

const base = {
  id: 'op-1',
  tenantId: 't-1',
  email: 'ana@example.com',
  displayName: 'Lola',
  role: 'OPERATOR',
  commissionBps: null as number | null,
  deletedAt: null as Date | null,
  invitedAt: null as Date | null,
  inviteToken: null as string | null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  payoutMethod: null as string | null,
  payoutAddress: null as string | null,
  payoutLabel: null as string | null,
  payoutMetadata: null as unknown,
  payoutAccountChangedAt: null as Date | null,
  payoutHoldUntil: null as Date | null,
  onboardingStatus: 'NEW',
  selfOnboardingToken: TOKEN_HASH,
  legalName: null as string | null,
  birthDate: null as Date | null,
  payoutHolderConfirmedAt: null as Date | null,
  oxiocardStatus: 'NO_SOLICITADA',
  oxiocardStatusAt: null as Date | null,
};

function makeOps(row: Partial<typeof base> = {}, opts: { oxiocard?: boolean } = {}) {
  const operator = { ...base, ...row };
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue(operator),
      findUnique: vi.fn().mockResolvedValue(operator),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...operator, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    venue: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Local' }) },
  };
  Object.assign(prisma, {
    asSystem: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  });
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const email = { send: vi.fn().mockResolvedValue({ delivered: false }) };
  const settings: Record<string, unknown> = { OPERATOR_BASE_URL: 'https://personal.example.com', OXIOCARD_ENABLED: opts.oxiocard ?? false };
  const config = { get: vi.fn((k: string) => settings[k]) };
  const jwt = {
    signAsync: vi.fn().mockResolvedValue(TOKEN),
    verifyAsync: vi.fn().mockResolvedValue({ sub: 'op-1', tenantId: 't-1', purpose: 'operator-self-onboarding', payout: true }),
  };
  const sessions = { revokeAllForUser: vi.fn(async () => 1) };
  const svc = new OperatorsService(prisma as never, email as never, audit as never, config as never, jwt as never, {} as never, sessions as never);
  return { svc, prisma, audit, sessions, jwt };
}

const savedData = (prisma: ReturnType<typeof makeOps>['prisma']) =>
  (prisma.user.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }).data;
const auditOf = (audit: ReturnType<typeof makeOps>['audit'], action: string) =>
  audit.log.mock.calls.map((c) => c[0] as { action: string; payload?: unknown }).find((e) => e.action === action);

describe('alta por enlace: nombre legal y fecha de nacimiento', () => {
  it('se guardan (el nombre cifrado) y el registro no lleva ninguno de los dos en claro', async () => {
    const { svc, prisma, audit } = makeOps();
    await expect(svc.submitSelfOnboarding(TOKEN, { legalName: 'Ana López Pérez', birthDate: ADULT })).resolves.toEqual({ ok: true });
    const data = savedData(prisma);
    expect(String(data.legalName)).toMatch(/^pa1:/);
    expect(data.birthDate).toEqual(birthDateValue(ADULT));
    expect(data.payoutHolderConfirmedAt).toBeNull();
    const logged = JSON.stringify(audit.log.mock.calls);
    expect(logged).not.toContain('López');
    expect(logged).not.toContain(ADULT);
    expect(auditOf(audit, 'operator.minor_blocked')).toBeUndefined();
  });

  it('menor de 18 que ya entraba: deja de entrar (otra contraseña, sesiones fuera, pendiente y bloqueada) y se avisa al dueño', async () => {
    const { svc, prisma, audit, sessions } = makeOps();
    await expect(svc.submitSelfOnboarding(TOKEN, { birthDate: MINOR })).resolves.toEqual({ ok: true, minor: true });
    const data = savedData(prisma);
    expect(data).toMatchObject({ inviteToken: null, onboardingStatus: 'BLOCKED' });
    expect(data.invitedAt).toBeInstanceOf(Date);
    expect(typeof data.passwordHash).toBe('string');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('op-1');
    const notice = auditOf(audit, 'operator.minor_blocked');
    expect(notice?.payload).toEqual({ via: 'enlace', name: 'Lola', wasActive: true });
    // Ni la fecha ni el hash en el registro (solo los nombres de los campos).
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(MINOR);
    expect(JSON.stringify(auditOf(audit, 'operator.self_onboarding.submitted')?.payload)).not.toContain('passwordHash');
  });

  it('la misma fecha de antes no vuelve a avisar', async () => {
    const { svc, audit } = makeOps({ birthDate: birthDateValue(MINOR), invitedAt: new Date() });
    await expect(svc.submitSelfOnboarding(TOKEN, { birthDate: MINOR })).resolves.toEqual({ ok: true });
    expect(auditOf(audit, 'operator.minor_blocked')).toBeUndefined();
  });
});

describe('menor de edad: no activa la cuenta', () => {
  it('aceptar la invitación, poner contraseña o mandar otra invitación: 403', async () => {
    const minor = { birthDate: birthDateValue(MINOR), invitedAt: new Date(), inviteToken: 'x' };
    const accept = makeOps(minor);
    accept.jwt.verifyAsync.mockResolvedValue({ sub: 'op-1', tenantId: 't-1', purpose: 'operator-invite' });
    accept.prisma.user.findUnique.mockResolvedValue({
      ...base,
      ...minor,
      inviteToken: createHash('sha256').update('invite-token').digest('hex'),
    });
    const refused = { response: expect.objectContaining({ code: MINOR_CANNOT_ACTIVATE }) };
    await expect(accept.svc.acceptInvite('invite-token', 'contraseña-larga')).rejects.toMatchObject(refused);
    expect(accept.prisma.user.update).not.toHaveBeenCalled();

    const reset = makeOps(minor);
    await expect(reset.svc.resetPassword('t-1', 'op-1', 'owner', null)).rejects.toBeInstanceOf(ForbiddenException);
    const again = makeOps(minor);
    await expect(again.svc.regenerateInvite('t-1', 'op-1', 'owner')).rejects.toMatchObject(refused);
  });

  it('el dueño pone una fecha de menor en el panel: mismo cierre y aviso, por el panel', async () => {
    const { svc, prisma, audit, sessions } = makeOps();
    const view = await svc.updateOperator('t-1', 'op-1', 'owner', 'OWNER', { birthDate: MINOR });
    expect(savedData(prisma)).toMatchObject({ onboardingStatus: 'BLOCKED', inviteToken: null });
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('op-1');
    expect(auditOf(audit, 'operator.minor_blocked')?.payload).toMatchObject({ via: 'panel' });
    expect(view.birthDate).toBe(MINOR);
    // El registro del cambio: sin la fecha ni el nombre legal.
    expect(auditOf(audit, 'operator.updated')?.payload).toEqual({ changes: { birthDate: 'cambiada' } });
  });

  it('nombre legal y fecha son del dueño: el encargado no los cambia', async () => {
    const { svc } = makeOps();
    await expect(svc.updateOperator('t-1', 'op-1', 'm', 'MANAGER', { legalName: 'Ana López' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.updateOperator('t-1', 'op-1', 'm', 'MANAGER', { birthDate: ADULT })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.updateOperator('t-1', 'op-1', 'm', 'MANAGER', { payoutHolderConfirmed: true })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('el titular de su cuenta contra su nombre legal', () => {
  const holderRow = (holder: string, legal: string) => ({
    payoutMethod: 'SEPA_IBAN',
    payoutAddress: sealPayoutValue('ES9121000418450200051332', { userId: 'op-1', field: 'address' }),
    payoutMetadata: { accountHolder: sealPayoutValue(holder, { userId: 'op-1', field: 'holder' }) },
    legalName: sealLegalName('op-1', legal),
  });

  it('el panel lo ve tapado y sabe si falta la confirmación del dueño', async () => {
    const { svc } = makeOps(holderRow('Pedro Gómez', 'Ana López'));
    const view = await svc.updateOperator('t-1', 'op-1', 'owner', 'OWNER', { phone: '600' });
    expect(view).toMatchObject({ legalNameMasked: 'A••• L•••', payoutHolderMismatch: true, payoutHolderUnconfirmed: true });
    expect(view).not.toHaveProperty('oxiocardStatus');
  });

  it('«la cuenta es suya» lo confirma; cambiar el nombre legal en la misma petición no lo deja sin confirmar', async () => {
    const { svc, prisma, audit } = makeOps(holderRow('Pedro Gómez', 'Ana López'));
    const view = await svc.updateOperator('t-1', 'op-1', 'owner', 'OWNER', { legalName: 'Ana María López', payoutHolderConfirmed: true });
    expect(savedData(prisma).payoutHolderConfirmedAt).toBeInstanceOf(Date);
    expect(view.payoutHolderUnconfirmed).toBe(false);
    expect(auditOf(audit, 'operator.updated')?.payload).toEqual({ changes: { legalName: 'A••• M••• L•••', payoutHolderConfirmed: true } });
  });

  it('otro nombre legal borra la confirmación de antes', async () => {
    const { svc, prisma } = makeOps({ ...holderRow('Pedro Gómez', 'Ana López'), payoutHolderConfirmedAt: new Date() });
    await svc.updateOperator('t-1', 'op-1', 'owner', 'OWNER', { legalName: 'Ana Ruiz' });
    expect(savedData(prisma).payoutHolderConfirmedAt).toBeNull();
  });
});

describe('OxioCard (OXIOCARD_ENABLED)', () => {
  it('apagada: la ruta no existe, el dueño no la cambia y el alta no la pide', async () => {
    const { svc, prisma } = makeOps();
    await expect(svc.requestMyOxiocard('op-1', 't-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.updateOperator('t-1', 'op-1', 'owner', 'OWNER', { oxiocardStatus: 'APROBADA' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.submitSelfOnboarding(TOKEN, { oxiocard: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect((await svc.getSelfOnboardingProfile(TOKEN)).oxiocardEnabled).toBe(false);
  });

  it('«Abrir mi OxioCard»: solo si no la había pedido; queda en el registro una vez', async () => {
    const { svc, prisma, audit } = makeOps({ oxiocardStatus: 'SOLICITADA', oxiocardStatusAt: new Date('2026-11-19T20:00:00Z') }, { oxiocard: true });
    await expect(svc.requestMyOxiocard('op-1', 't-1')).resolves.toEqual({ status: 'SOLICITADA', at: '2026-11-19T20:00:00.000Z' });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'op-1', tenantId: 't-1', role: 'OPERATOR', oxiocardStatus: 'NO_SOLICITADA' },
      data: { oxiocardStatus: 'SOLICITADA', oxiocardStatusAt: expect.any(Date) },
    });
    expect(auditOf(audit, 'operator.oxiocard_requested')).toBeDefined();

    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    audit.log.mockClear();
    await svc.requestMyOxiocard('op-1', 't-1');
    expect(auditOf(audit, 'operator.oxiocard_requested')).toBeUndefined();
  });

  it('el dueño cambia el estado a mano; desde el alta se pide si no estaba pedida', async () => {
    const owner = makeOps({}, { oxiocard: true });
    const view = await owner.svc.updateOperator('t-1', 'op-1', 'owner', 'OWNER', { oxiocardStatus: 'EN_VERIFICACION' });
    expect(savedData(owner.prisma)).toMatchObject({ oxiocardStatus: 'EN_VERIFICACION', oxiocardStatusAt: expect.any(Date) });
    expect(view.oxiocardStatus).toBe('EN_VERIFICACION');

    const alta = makeOps({}, { oxiocard: true });
    await alta.svc.submitSelfOnboarding(TOKEN, { oxiocard: true });
    expect(savedData(alta.prisma)).toMatchObject({ oxiocardStatus: 'SOLICITADA' });

    const already = makeOps({ oxiocardStatus: 'APROBADA' }, { oxiocard: true });
    await already.svc.submitSelfOnboarding(TOKEN, { oxiocard: true });
    expect(savedData(already.prisma)).not.toHaveProperty('oxiocardStatus');
  });

  it('su app la ve en «Ganancias» (con la OxioCard apagada, null)', async () => {
    const on = makeOps({ oxiocardStatus: 'RECHAZADA' }, { oxiocard: true });
    Object.assign(on.prisma, { $queryRaw: vi.fn().mockResolvedValue([]) });
    Object.assign(on.prisma.venue, { findUnique: vi.fn().mockResolvedValue({ payoutHoldDays: 0 }) });
    expect((await on.svc.getMyPayoutInfo('op-1', 't-1')).oxiocard).toEqual({ status: 'RECHAZADA', at: null });
    const off = makeOps();
    Object.assign(off.prisma, { $queryRaw: vi.fn().mockResolvedValue([]) });
    Object.assign(off.prisma.venue, { findUnique: vi.fn().mockResolvedValue({ payoutHoldDays: 0 }) });
    expect((await off.svc.getMyPayoutInfo('op-1', 't-1')).oxiocard).toBeNull();
  });
});
