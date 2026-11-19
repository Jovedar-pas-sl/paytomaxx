// Integración (Postgres real, FORCE RLS, rol sin superusuario): «Cuenta de cobro segura» (19-nov-2026).
//  - La cuenta de cobro y el titular se guardan cifrados (pa1:…) y, aparte, tapados; en la base no
//    queda el IBAN en claro, ni en el registro, ni en lo que devuelve el panel.
//  - Cambiarla pide siempre la 2FA del dueño; verla entera («Ver cuenta para pagar»), también.
//  - Al cambiarla: correo a la compañera, aviso en su app, incidencia y 48 h sin «Marcar pagado»
//    a la cuenta nueva (en efectivo sí; la primera cuenta, sin espera).
//  - El relleno cifra lo que estaba en claro, se puede repetir y no cuenta como un cambio.
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
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
import { PayoutAccountBackfill } from '../../src/modules/operators/payout-account-backfill';
import { lockOperatorPayouts } from '../../src/modules/operators/payout-selection';
import { TreasuryService } from '../../src/modules/treasury/treasury.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
// El registro de verdad (audit_events): se comprueba lo que queda escrito.
const audit = new AuditService(prisma, cls as never);
const sent: Array<{ to: string; subject: string; html: string; text?: string }> = [];
const email = {
  send: async (m: (typeof sent)[number]) => {
    sent.push(m);
    return { ok: true, delivered: true };
  },
};
const settings: Record<string, string | number> = { OPERATOR_BASE_URL: 'https://personal.example.com' };
const config = {
  get: (k: string) => settings[k],
  getOrThrow: (k: string) => {
    if (settings[k] === undefined) throw new Error(`sin ${k}`);
    return settings[k];
  },
};
// La red de mentira: el hash «cuadra» y se apunta contra qué dirección se comparó.
const verifiedAgainst: Array<string | null> = [];
const verifier = {
  verify: async (i: { expectedToAddress: string | null }) => {
    verifiedAgainst.push(i.expectedToAddress);
    return { matched: true, status: 'MATCHED', occurredAt: new Date(), actualAmountCents: null };
  },
};
const fx = { getEurToUsdtRateInfo: async () => ({ rate: 1.07, degraded: false }), forMethod: () => verifier };
const jwt = new JwtService({ secret: 'clave-de-pruebas-de-la-cuenta-de-cobro-0123456789' });
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma, new TotpAttemptsService(new LockoutService(redis as never), redis as never));

const operators = new OperatorsService(prisma, email as never, audit, config as never, jwt, fx as never, {} as never);
const requests = new ApprovalRequestsService(prisma, audit, config as never, { enabled: () => false, requested: vi.fn() } as never);
const admin = new AdminController(prisma, {} as never, audit, operators, {} as never, cls as never, totp, requests);
const incidents = new IncidentsService(prisma, audit);
const treasury = new TreasuryService(prisma, audit, fx as never, config as never);
const backfill = new PayoutAccountBackfill(prisma);

/** Una petición del panel o de la app de ese local (como tras AuthGuard). */
function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-cc-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
/** Sin local ni sesión: el enlace de alta, o el arranque del API. */
function asPublic<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-cc' });
    return fn();
  });
}
const sys = <T>(fn: Parameters<PrismaService['asSystem']>[0]) => asPublic(() => prisma.asSystem(fn)) as Promise<T>;

/** Código HTTP y cuerpo de un error de Nest. */
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
const IBAN2 = 'ES7921000813610123456789';
const TRON = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
let seq = 0;
const uniq = (p: string) => `${p}-${r}-${++seq}`;

let V: string;
let B: string;
let term: string;
let boss: string;
let bossNo2fa: string;
let manager: string;
let bossB: string;
const secrets = new Map<string, string>();

async function newUser(tenantId: string, role: 'OWNER' | 'MANAGER', withTotp: boolean): Promise<string> {
  const secret = withTotp ? totp.newSecret() : null;
  const id = await sys<string>(async (tx) =>
    (
      await tx.user.create({
        data: {
          tenantId,
          email: `${uniq(role.toLowerCase())}@x.es`,
          passwordHash: 'x',
          role,
          displayName: role === 'OWNER' ? 'Javi' : 'Marta',
          totpSecret: secret ? totp.sealSecret(secret) : null,
        },
      })
    ).id,
  );
  if (secret) secrets.set(id, secret);
  return id;
}
/** Su código de ahora (en las pruebas vale más de una vez: se olvidan los usados). */
async function codeOf(userId: string): Promise<string> {
  await totp.forgetUsedCodes(userId);
  return totpCodeAt(secrets.get(userId)!);
}
const jwtOf = (userId: string, role: 'OWNER' | 'MANAGER', tenantId = V) => ({ sub: userId, role, tenantId }) as unknown as JwtPayload;

/** Una compañera (sin cuenta, o con lo que se le pase tal cual a la base). */
async function newChica(name: string, data: Record<string, unknown> = {}, tenantId = V): Promise<string> {
  return sys<string>(async (tx) =>
    (
      await tx.user.create({
        data: { tenantId, email: `${uniq('chica')}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: name, ...data } as never,
      })
    ).id,
  );
}
/** Un cobro de hace dos horas con su comisión del 90 % (el local paga al cierre de la noche). */
async function newEarning(chica: string, amountCents: number): Promise<void> {
  await sys(async (tx) => {
    const at = new Date(Date.now() - 2 * HOUR);
    const p = await tx.payment.create({
      data: {
        tenantId: V, terminalId: term, idempotencyKey: uniq('k'), qrToken: uniq('q'), qrExpiresAt: new Date(Date.now() + HOUR),
        status: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: uniq('PT'), amountCents, availableAmountCents: amountCents,
        createdByUserId: chica, revenueCategory: 'CHICA_SERVICE', authorizedAt: at, createdAt: at, cardLast4: '4242', cardBrand: 'VISA',
      } as never,
    });
    await tx.operatorEarning.create({
      data: { tenantId: V, operatorId: chica, paymentId: p.id, paymentAmountCents: amountCents, commissionBps: 9000, commissionCents: Math.round(amountCents * 0.9), createdAt: at },
    });
  });
}

/** La fila de la persona tal cual está en la base, entera y en texto (para buscar lo que no debe estar). */
const rawUser = (id: string) =>
  sys<string>(async (tx) => (await tx.$queryRaw<Array<{ j: string }>>`SELECT row_to_json(u)::text AS j FROM users u WHERE u.id = ${id}::uuid`)[0]!.j);
interface Stored {
  payoutMethod: string | null;
  payoutAddress: string | null;
  payoutMetadata: { accountHolder?: string; bankName?: string } | null;
  payoutAddressMasked: string | null;
  payoutHolderMasked: string | null;
  payoutAccountChangedAt: Date | null;
  payoutHoldUntil: Date | null;
  payoutNoticeSeenAt: Date | null;
  updatedAt: Date;
}
const stored = (id: string) => sys<Stored>((tx) => tx.user.findUniqueOrThrow({ where: { id } }) as never);
/** Todo lo que el registro guarda de esa persona, en texto. */
const auditOf = (targetId: string) =>
  sys<Array<{ action: string; actorId: string | null; payload: Record<string, unknown> | null }>>((tx) =>
    tx.auditEvent.findMany({ where: { targetId }, orderBy: { id: 'asc' }, select: { action: true, actorId: true, payload: true } }),
  );
const payoutsOf = (chica: string) =>
  sys<Array<{ id: string; totalCents: number; paidToAddress: string | null; externalRail: string | null }>>((tx) =>
    tx.operatorPayout.findMany({ where: { operatorId: chica }, orderBy: { createdAt: 'asc' } }),
  );

const patch = (userId: string, role: 'OWNER' | 'MANAGER', chica: string, dto: Record<string, unknown>, tenantId = V) =>
  asStaff(tenantId, () => admin.updateOperator(tenantId, jwtOf(userId, role, tenantId), chica, dto as never));
/** El dueño (con su 2FA) le pone esta cuenta SEPA. */
const setSepa = async (chica: string, iban: string, holder: string) =>
  patch(boss, 'OWNER', chica, { payoutMethod: 'SEPA_IBAN', payoutAddress: iban, payoutMetadata: { accountHolder: holder }, totpCode: await codeOf(boss) });
const reveal = (userId: string, role: 'OWNER' | 'MANAGER', chica: string, body: Record<string, unknown>, tenantId = V) =>
  asStaff(tenantId, () => admin.revealPayoutAccount(tenantId, jwtOf(userId, role, tenantId), chica, body as never));
const markPaid = (userId: string, role: 'OWNER' | 'MANAGER', chica: string, dto: Record<string, unknown>) =>
  asStaff(V, () => admin.createOperatorPayout(V, jwtOf(userId, role), chica, dto as never));

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ V, B, term } = await sys<{ V: string; B: string; term: string }>(async (tx) => {
    const v = await tx.venue.create({ data: { name: `Sala Cuenta ${r}`, slug: `cuenta-${r}`, payoutHoldDays: 0 } });
    const b = await tx.venue.create({ data: { name: `Otra Sala ${r}`, slug: `cuenta-b-${r}`, payoutHoldDays: 0 } });
    const t = await tx.terminal.create({ data: { tenantId: v.id, externalId: `CC-${r}`, label: 'Barra' } });
    return { V: v.id, B: b.id, term: t.id };
  }));
  boss = await newUser(V, 'OWNER', true);
  bossNo2fa = await newUser(V, 'OWNER', false);
  manager = await newUser(V, 'MANAGER', false);
  bossB = await newUser(B, 'OWNER', true);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('guardar la cuenta de cobro: cifrada en la base, tapada en el panel y en el registro', () => {
  let ana: string;

  it('el dueño con su 2FA pone la primera cuenta: en la base no queda ni el IBAN ni el titular en claro', async () => {
    ana = await newChica('Ana');
    const view = await setSepa(ana, ' es91 2100 0418 4502 0005 1332 ', ' Ana López ');
    expect(view).toMatchObject({ payoutMethod: 'SEPA_IBAN', payoutAddressMasked: 'ES91 •••• •••• 1332', payoutHolderMasked: 'A••• L•••', payoutHolderMismatch: false });
    expect(view).not.toHaveProperty('payoutAddress');

    const row = await stored(ana);
    expect(row.payoutAddress).toMatch(/^pa1:/);
    expect(row.payoutMetadata?.accountHolder).toMatch(/^pa1:/);
    expect(row).toMatchObject({ payoutAddressMasked: 'ES91 •••• •••• 1332', payoutHolderMasked: 'A••• L•••' });
    // La primera cuenta: con aviso, sin espera.
    expect(row.payoutAccountChangedAt).toBeInstanceOf(Date);
    expect(row.payoutHoldUntil).toBeNull();
    const raw = await rawUser(ana);
    expect(raw).not.toContain(IBAN);
    expect(raw).not.toContain('López');
  });

  it('el registro (operator.updated y el cambio de cuenta) lleva la cuenta y el titular tapados, sin el código 2FA', async () => {
    const rows = await auditOf(ana);
    expect(rows.map((a) => a.action)).toEqual(['operator.updated', 'operator.payout_account_changed']);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(IBAN);
    expect(text).not.toContain('López');
    expect(text).not.toContain('totpCode');
    expect(rows[0]!.payload).toMatchObject({ changes: { payoutAddress: 'ES91 •••• •••• 1332', payoutMetadata: { accountHolder: 'A••• L•••' } } });
    expect(rows[1]).toMatchObject({
      actorId: boss,
      payload: {
        via: 'panel',
        name: 'Ana',
        holderMismatch: false,
        holdUntil: null,
        before: { payoutMethod: null, payoutAddress: null },
        after: { payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES91 •••• •••• 1332', payoutHolder: 'A••• L•••' },
      },
    });
  });

  it('a ella le llega un correo con la cuenta tapada (nunca entera)', async () => {
    const row = await sys<{ email: string }>((tx) => tx.user.findUniqueOrThrow({ where: { id: ana }, select: { email: true } }));
    const mail = sent.filter((m) => m.to === row.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe(`Tu cuenta de cobro en Sala Cuenta ${r} ha cambiado`);
    expect(mail[0]!.text).toContain('Ahora te pagan a: ES91 •••• •••• 1332.');
    expect(mail[0]!.text).toContain('Si no lo has pedido tú');
    expect(JSON.stringify(mail)).not.toContain(IBAN);
  });

  it('GET /admin/operators: el encargado (y el dueño) solo ven la cuenta tapada', async () => {
    const list = await asStaff(V, () => admin.listOperators(V));
    const mine = list.find((o) => o.id === ana)!;
    expect(mine).toMatchObject({ payoutMethod: 'SEPA_IBAN', payoutAddressMasked: 'ES91 •••• •••• 1332', payoutHolderMasked: 'A••• L•••' });
    const text = JSON.stringify(list);
    expect(text).not.toContain(IBAN);
    expect(text).not.toContain('López');
    expect(text).not.toContain('pa1:');
  });

  it('IBAN SEPA sin titular: 400 y no se guarda nada', async () => {
    const eva = await newChica('Eva');
    const res = await failure(patch(boss, 'OWNER', eva, { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, totpCode: await codeOf(boss) }));
    expect(res).toMatchObject({ status: 400, body: { message: 'Falta el titular de la cuenta' } });
    expect(await stored(eva)).toMatchObject({ payoutMethod: null, payoutAddress: null });
  });

  it('el titular que no se parece a su nombre: se guarda y se avisa al dueño (panel e incidencia)', async () => {
    const lola = await newChica('Lola');
    const view = await setSepa(lola, IBAN2, 'Svetlana Ivanova');
    expect(view.payoutHolderMismatch).toBe(true);
    const list = await asStaff(V, () => incidents.list(V));
    const mine = list.find((i) => i.kind === 'sensitive_action' && i.detail.includes('(Lola)'));
    expect(mine).toMatchObject({ title: 'Cuenta de cobro cambiada', ackable: true });
    expect(mine!.detail).toMatch(/^Javi ha cambiado la cuenta de cobro de una compañera/);
    expect(mine!.detail).toContain('El titular no se parece a su nombre');
    // A Telegram, sin nombres ni cuenta.
    expect(mine!.alertDetail).not.toContain('Lola');
    expect(mine!.alertDetail).not.toContain('6789');
  });
});

describe('cambiar la cuenta de cobro pide siempre la 2FA del dueño', () => {
  it('sin 2FA activada: 403 con «actívala» y no cambia nada; sin código o con uno malo, tampoco; el encargado, nunca', async () => {
    const eva = await newChica('Eva');
    const account = { payoutMethod: 'USDT_TRC20', payoutAddress: TRON };

    const notEnrolled = await failure(patch(bossNo2fa, 'OWNER', eva, account));
    expect(notEnrolled).toMatchObject({ status: 403, body: { code: 'TOTP_NOT_ENROLLED' } });
    expect(String(notEnrolled.body.message)).toMatch(/cuenta de cobro/);
    expect(String(notEnrolled.body.message)).toMatch(/Ajustes → Seguridad/);

    expect(await failure(patch(boss, 'OWNER', eva, account))).toMatchObject({ status: 403, body: { code: 'TOTP_REQUIRED' } });
    expect(await failure(patch(boss, 'OWNER', eva, { ...account, totpCode: '000000' }))).toMatchObject({ status: 403, body: { code: 'TOTP_INVALID' } });
    await totp.forgetUsedCodes(boss);
    expect(await failure(patch(manager, 'MANAGER', eva, account))).toMatchObject({ status: 403 });

    expect(await stored(eva)).toMatchObject({ payoutMethod: null, payoutAddress: null, payoutAccountChangedAt: null });
    // Lo que no es la cuenta de cobro no pide 2FA.
    await expect(patch(bossNo2fa, 'OWNER', eva, { displayName: 'Eva María' })).resolves.toMatchObject({ displayName: 'Eva María' });
  });
});

describe('«Ver cuenta para pagar»: entera solo para el dueño, con su 2FA, y queda en el registro sin la cuenta', () => {
  it('el dueño con su código la ve entera; el encargado, sin 2FA o de otro local, no', async () => {
    const ana = await newChica('Ana');
    await setSepa(ana, IBAN, 'Ana López');

    const full = await reveal(boss, 'OWNER', ana, { totpCode: await codeOf(boss) });
    expect(full).toEqual({ userId: ana, payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutLabel: null, payoutMetadata: { accountHolder: 'Ana López' } });

    expect(await failure(reveal(manager, 'MANAGER', ana, {}))).toMatchObject({ status: 403 });
    expect(await failure(reveal(bossNo2fa, 'OWNER', ana, {}))).toMatchObject({ status: 403, body: { code: 'TOTP_NOT_ENROLLED' } });
    expect(await failure(reveal(boss, 'OWNER', ana, {}))).toMatchObject({ status: 403, body: { code: 'TOTP_REQUIRED' } });
    // El dueño de otro local, con su 2FA de verdad: no existe para él.
    expect(await failure(reveal(bossB, 'OWNER', ana, { totpCode: await codeOf(bossB) }, B))).toMatchObject({ status: 404 });

    const seen = (await auditOf(ana)).filter((a) => a.action === 'operator.payout_account_revealed');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ actorId: boss, payload: { payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES91 •••• •••• 1332', payoutHolder: 'A••• L•••' } });
    expect(JSON.stringify(seen)).not.toContain(IBAN);
  });
});

describe('48 h de espera: no se marca pagado a una cuenta recién cambiada', () => {
  let ana: string;

  it('la primera cuenta no espera; cambiarla sí: 48 h a la cuenta nueva', async () => {
    ana = await newChica('Ana');
    await setSepa(ana, IBAN, 'Ana López');
    expect((await stored(ana)).payoutHoldUntil).toBeNull();

    const before = Date.now();
    const view = await setSepa(ana, IBAN2, 'Ana López');
    const row = await stored(ana);
    const hold = row.payoutHoldUntil!.getTime();
    expect(hold).toBeGreaterThanOrEqual(before + 48 * HOUR);
    expect(hold).toBeLessThanOrEqual(Date.now() + 48 * HOUR);
    expect(view.payoutHoldUntil).toBe(row.payoutHoldUntil!.toISOString());
    expect(row.payoutAddressMasked).toBe('ES79 •••• •••• 6789');
    // Y el registro dice hasta cuándo, con las dos cuentas tapadas.
    const last = (await auditOf(ana)).filter((a) => a.action === 'operator.payout_account_changed').pop()!;
    expect(last.payload).toMatchObject({
      holdUntil: row.payoutHoldUntil!.toISOString(),
      before: { payoutAddress: 'ES91 •••• •••• 1332' },
      after: { payoutAddress: 'ES79 •••• •••• 6789' },
    });
  });

  it('«Marcar pagado» a esa cuenta: 409 con la fecha desde la que se puede, y no se apunta nada', async () => {
    await newEarning(ana, 10_000);
    const hold = (await stored(ana)).payoutHoldUntil!;
    const res = await failure(markPaid(boss, 'OWNER', ana, { externalRail: 'SEPA_IBAN', totpCode: await codeOf(boss) }));
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_ACCOUNT_TOO_NEW', payableFrom: hold.toISOString() } });
    expect(String(res.body.message)).toMatch(/La cuenta de cobro de Ana cambió hace menos de 48 h: se le puede pagar a esa cuenta a partir del \d+ de \w+ a las \d\d:\d\d/);
    // Tampoco eligiendo otra vía que no sea el efectivo, ni sin decir cuál.
    expect(await failure(markPaid(boss, 'OWNER', ana, { externalRail: 'REVOLUT_TAG', totpCode: await codeOf(boss) }))).toMatchObject({ status: 409, body: { code: 'PAYOUT_ACCOUNT_TOO_NEW' } });
    expect(await failure(markPaid(boss, 'OWNER', ana, { totpCode: await codeOf(boss) }))).toMatchObject({ status: 409, body: { code: 'PAYOUT_ACCOUNT_TOO_NEW' } });
    expect(await payoutsOf(ana)).toEqual([]);
  });

  it('el encargado tampoco lo puede pedir («Por aprobar») mientras dura la espera', async () => {
    const res = await failure(markPaid(manager, 'MANAGER', ana, { externalRail: 'SEPA_IBAN' }));
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_ACCOUNT_TOO_NEW' } });
    expect(await sys<number>((tx) => tx.approvalRequest.count({ where: { targetId: ana } }))).toBe(0);
  });

  it('en efectivo sí se le paga ya', async () => {
    const paid = await markPaid(boss, 'OWNER', ana, { externalRail: 'MANUAL_CASH', totpCode: await codeOf(boss) });
    expect(paid).toMatchObject({ totalCents: 9000, earningCount: 1 });
  });

  it('pasadas las 48 h, sí; el pago guarda la cuenta cifrada, nunca en claro', async () => {
    await newEarning(ana, 20_000);
    await sys((tx) => tx.user.update({ where: { id: ana }, data: { payoutHoldUntil: new Date(Date.now() - 1000) } as never }));
    const paid = await markPaid(boss, 'OWNER', ana, { externalRail: 'SEPA_IBAN', totpCode: await codeOf(boss) });
    expect(paid).toMatchObject({ totalCents: 18_000 });
    const rows = await payoutsOf(ana);
    expect(rows).toHaveLength(2);
    for (const p of rows) {
      expect(p.paidToAddress).toMatch(/^pa1:/);
      expect(p.paidToAddress).not.toContain(IBAN2);
    }
    // Y el panel ya no enseña la espera.
    const view = (await asStaff(V, () => admin.listOperators(V))).find((o) => o.id === ana)!;
    expect(view.payoutHoldUntil).toBeNull();
  });

  it('pasar a efectivo no tiene espera', async () => {
    const eva = await newChica('Eva');
    await setSepa(eva, IBAN, 'Eva Ruiz');
    await patch(boss, 'OWNER', eva, { payoutMethod: 'MANUAL_CASH', payoutAddress: null, totpCode: await codeOf(boss) });
    expect(await stored(eva)).toMatchObject({ payoutMethod: 'MANUAL_CASH', payoutAddress: null, payoutAddressMasked: null, payoutHoldUntil: null, payoutMetadata: null, payoutHolderMasked: null });
  });
});

describe('transferencia internacional: el banco, el SWIFT y el país también son «a dónde va el dinero»', () => {
  const WIRE = 'GE29NB0000000101904917';
  const wire = (swiftBic: string) => ({
    payoutMethod: 'WIRE_INTERNATIONAL',
    payoutAddress: WIRE,
    payoutMetadata: { bankName: 'TBC Bank', swiftBic, country: 'Georgia', accountHolder: 'Camila Rodriguez' },
  });
  let cami: string;

  it('cambiar solo el SWIFT (misma cuenta y mismo titular): 48 h de espera, correo, aviso en su app y el banco de antes en el registro', async () => {
    cami = await newChica('Camila');
    await patch(boss, 'OWNER', cami, { ...wire('TBCBGE22'), totpCode: await codeOf(boss) });
    const first = await stored(cami);
    expect(first.payoutHoldUntil).toBeNull();
    await asStaff(V, () => operators.markPayoutNoticeSeen(cami, V));
    const mailsBefore = sent.length;

    const before = Date.now();
    const view = await patch(boss, 'OWNER', cami, { ...wire('BAGAGE22'), totpCode: await codeOf(boss) });
    const row = await stored(cami);
    expect(row.payoutHoldUntil!.getTime()).toBeGreaterThanOrEqual(before + 48 * HOUR);
    expect(view.payoutHoldUntil).toBe(row.payoutHoldUntil!.toISOString());
    expect(row.payoutAccountChangedAt!.getTime()).toBeGreaterThan(first.payoutAccountChangedAt!.getTime());
    expect(row.payoutMetadata).toMatchObject({ swiftBic: 'BAGAGE22' });
    // A ella: correo y aviso en su app.
    expect(sent.length).toBe(mailsBefore + 1);
    expect(await asStaff(V, () => operators.getPayoutNotice(cami, V))).toMatchObject({ masked: 'GE29 •••• •••• 4917' });
    // En el registro (lo que enseña Incidencias), el banco de antes y el de ahora: la cuenta tapada es la misma.
    const last = (await auditOf(cami)).filter((a) => a.action === 'operator.payout_account_changed').pop()!;
    expect(last.payload).toMatchObject({
      holdUntil: row.payoutHoldUntil!.toISOString(),
      before: { payoutAddress: 'GE29 •••• •••• 4917', payoutBank: { swiftBic: 'TBCBGE22' } },
      after: { payoutAddress: 'GE29 •••• •••• 4917', payoutBank: { swiftBic: 'BAGAGE22' } },
    });
    expect(JSON.stringify(last)).not.toContain(WIRE);
    expect(JSON.stringify(last)).not.toContain('Rodriguez');
    // Y no se le marca pagado a esa cuenta hasta pasadas las 48 h.
    await newEarning(cami, 10_000);
    const paid = await failure(markPaid(boss, 'OWNER', cami, { externalRail: 'WIRE_INTERNATIONAL', totpCode: await codeOf(boss) }));
    expect(paid).toMatchObject({ status: 409, body: { code: 'PAYOUT_ACCOUNT_TOO_NEW', payableFrom: row.payoutHoldUntil!.toISOString() } });
  });

  it('los mismos datos otra vez (la base devuelve el JSON en otro orden): ni espera nueva, ni aviso, ni correo', async () => {
    const before = await stored(cami);
    await asStaff(V, () => operators.markPayoutNoticeSeen(cami, V));
    const mailsBefore = sent.length;
    await patch(boss, 'OWNER', cami, { ...wire('bagage22'), payoutAddress: 'ge29 nb00 0000 0101 9049 17', totpCode: await codeOf(boss) });
    const row = await stored(cami);
    expect(row.payoutHoldUntil).toEqual(before.payoutHoldUntil);
    expect(row.payoutAccountChangedAt).toEqual(before.payoutAccountChangedAt);
    expect(sent.length).toBe(mailsBefore);
    expect(await asStaff(V, () => operators.getPayoutNotice(cami, V))).toBeNull();
  });
});

describe('a la vez: ni dos cambios de cuenta se pisan, ni un pago se cuela mientras cambia', () => {
  /**
   * Dos cosas «a la vez» sin depender del reloj: `hold` toma algo (la fila o
   * un candado) en una transacción; `request` arranca y se queda esperándolo;
   * entonces `change` (en la misma transacción) y, al confirmarla, `request` sigue.
   */
  async function whileWaiting<T>(
    hold: Parameters<PrismaService['asSystem']>[0],
    request: () => Promise<T>,
    change: Parameters<PrismaService['asSystem']>[0] = async () => undefined,
  ): Promise<T> {
    let pending!: Promise<T>;
    await sys(async (tx) => {
      await hold(tx);
      const [me] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      pending = request();
      pending.catch(() => undefined);
      for (;;) {
        const [waiting] = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${me!.pid}::int = ANY(pg_blocking_pids(pid))`;
        if (waiting!.n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await change(tx);
    });
    return pending;
  }

  it('dos cambios de cuenta a la vez: el que leyó la cuenta de antes recibe 409, no pisa al otro y no avisa de nada', async () => {
    const noa = await newChica('Noa');
    await setSepa(noa, IBAN, 'Noa Gil');
    const mailsBefore = sent.length;
    const auditsBefore = (await auditOf(noa)).length;
    const otherAt = new Date();
    const code = await codeOf(boss);

    const res = await failure(
      whileWaiting(
        // Otro cambio de su cuenta (p. ej. desde OxioPay), aún sin confirmar: el dueño lee la de antes...
        (tx) => tx.user.update({ where: { id: noa }, data: { payoutAddressMasked: 'la del otro cambio', payoutAccountChangedAt: otherAt } as never }),
        // ...y su guardado se queda esperando a que el otro termine.
        () => patch(boss, 'OWNER', noa, { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN2, payoutMetadata: { accountHolder: 'Noa Gil' }, totpCode: code }),
      ),
    );
    expect(res.status).toBe(409);
    expect(String(res.body.message)).toMatch(/acaba de cambiar por otro lado/);
    expect(await stored(noa)).toMatchObject({ payoutAddressMasked: 'la del otro cambio', payoutAccountChangedAt: otherAt, payoutHoldUntil: null });
    expect(sent.length).toBe(mailsBefore);
    expect((await auditOf(noa)).length).toBe(auditsBefore);
    // Otra vez, ya con la cuenta de ahora delante: se guarda (con su espera).
    await setSepa(noa, IBAN2, 'Noa Gil');
    expect((await stored(noa)).payoutHoldUntil).toBeInstanceOf(Date);
  });

  it('«Marcar pagado» esperando su turno mientras la cuenta cambia: mira la espera al tocarle, no la de antes', async () => {
    const lia = await newChica('Lía');
    await setSepa(lia, IBAN, 'Lía Sanz');
    await newEarning(lia, 10_000);
    const hold = new Date(Date.now() + 48 * HOUR);
    const code = await codeOf(boss);

    const res = await failure(
      whileWaiting(
        // El candado de sus pagos, tomado (otro pago o una petición en marcha): «Marcar pagado» espera su turno...
        (tx) => lockOperatorPayouts(tx, lia),
        () => markPaid(boss, 'OWNER', lia, { externalRail: 'SEPA_IBAN', totpCode: code }),
        // ...y, mientras espera, le cambian la cuenta.
        (tx) => tx.user.update({ where: { id: lia }, data: { payoutHoldUntil: hold, payoutAccountChangedAt: new Date() } as never }),
      ),
    );
    expect(res).toMatchObject({ status: 409, body: { code: 'PAYOUT_ACCOUNT_TOO_NEW', payableFrom: hold.toISOString() } });
    expect(await payoutsOf(lia)).toEqual([]);
  });
});

describe('aviso a la compañera en su app: «Tu cuenta de cobro ha cambiado»', () => {
  it('al entrar lo ve (tapada) hasta que pulsa «Entendido»; un cambio nuevo vuelve a avisar', async () => {
    const ana = await newChica('Ana');
    expect(await asStaff(V, () => operators.getPayoutNotice(ana, V))).toBeNull();

    await setSepa(ana, IBAN, 'Ana López');
    const notice = await asStaff(V, () => operators.getPayoutNotice(ana, V));
    expect(notice).toEqual({ changedAt: (await stored(ana)).payoutAccountChangedAt!.toISOString(), method: 'SEPA_IBAN', masked: 'ES91 •••• •••• 1332' });
    // «Ganancias» enseña lo mismo, tapado.
    expect((await asStaff(V, () => operators.getMyPayoutInfo(ana, V))).account).toEqual({ method: 'SEPA_IBAN', label: null, masked: 'ES91 •••• •••• 1332' });

    await asStaff(V, () => operators.markPayoutNoticeSeen(ana, V));
    expect(await asStaff(V, () => operators.getPayoutNotice(ana, V))).toBeNull();

    await setSepa(ana, IBAN2, 'Ana López');
    expect(await asStaff(V, () => operators.getPayoutNotice(ana, V))).toMatchObject({ masked: 'ES79 •••• •••• 6789' });
    // Cambiar solo el alias no es un cambio de cuenta: ni aviso nuevo ni más espera.
    const before = await stored(ana);
    await asStaff(V, () => operators.markPayoutNoticeSeen(ana, V));
    await patch(boss, 'OWNER', ana, { payoutLabel: 'Mi banco', totpCode: await codeOf(boss) });
    expect(await asStaff(V, () => operators.getPayoutNotice(ana, V))).toBeNull();
    expect((await stored(ana)).payoutHoldUntil).toEqual(before.payoutHoldUntil);
  });

  it('el aviso de otra persona (o de otro local) no se ve ni se marca', async () => {
    const ana = await newChica('Ana');
    await setSepa(ana, IBAN, 'Ana López');
    expect(await asStaff(B, () => operators.getPayoutNotice(ana, B))).toBeNull();
    await asStaff(B, () => operators.markPayoutNoticeSeen(ana, B));
    expect((await stored(ana)).payoutNoticeSeenAt).toBeNull();
  });
});

describe('el enlace de alta: su primera cuenta, cifrada, y la respuesta nunca la lleva entera', () => {
  const linkFor = async (chica: string, userId: string, role: 'OWNER' | 'MANAGER') =>
    (await asStaff(V, () => operators.createSelfOnboardingLink(V, chica, userId, role))).url.split('/onboarding/')[1]!;

  it('con el enlace del dueño pone su cuenta (con titular): cifrada, sin espera, con aviso «por el enlace» y correo', async () => {
    const mia = await newChica('Mía');
    const token = await linkFor(mia, boss, 'OWNER');
    const noHolder = asPublic(() => operators.submitSelfOnboarding(token, { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN }));
    expect(await failure(noHolder)).toMatchObject({ status: 400, body: { message: 'Falta el titular de la cuenta' } });

    const mailsBefore = sent.length;
    await asPublic(() =>
      operators.submitSelfOnboarding(token, { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutMetadata: { accountHolder: 'Mía Torres' } }),
    );
    const row = await stored(mia);
    expect(row.payoutAddress).toMatch(/^pa1:/);
    expect(row).toMatchObject({ payoutAddressMasked: 'ES91 •••• •••• 1332', payoutHolderMasked: 'M••• T•••', payoutHoldUntil: null });
    expect(await rawUser(mia)).not.toContain(IBAN);
    const changed = (await auditOf(mia)).find((a) => a.action === 'operator.payout_account_changed')!;
    expect(changed).toMatchObject({ actorId: mia, payload: { via: 'enlace', after: { payoutAddress: 'ES91 •••• •••• 1332' } } });
    expect(JSON.stringify(await auditOf(mia))).not.toContain(IBAN);
    expect(sent.length).toBe(mailsBefore + 1);
    // En Incidencias, con su texto.
    const inbox = await asStaff(V, () => incidents.list(V));
    expect(inbox.some((i) => i.title === 'Cuenta de cobro puesta con el enlace de alta' && i.detail.includes('(Mía)'))).toBe(true);
  });

  it('quien ya tiene cuenta: el enlace solo la devuelve tapada y no la cambia; la propuesta queda tapada en el registro', async () => {
    const noa = await newChica('Noa');
    await setSepa(noa, IBAN, 'Noa Gil');
    const token = await linkFor(noa, manager, 'MANAGER');
    const profile = await asPublic(() => operators.getSelfOnboardingProfile(token));
    expect(profile).toMatchObject({ payoutMethod: 'SEPA_IBAN', payoutAddressMasked: 'ES91 •••• •••• 1332', canSetPayout: false });
    expect(profile).not.toHaveProperty('payoutAddress');
    expect(JSON.stringify(profile)).not.toContain(IBAN);
    expect(JSON.stringify(profile)).not.toContain('pa1:');

    const saved = await asPublic(() =>
      operators.submitSelfOnboarding(token, { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN2, payoutMetadata: { accountHolder: 'Otra Persona' } }),
    );
    expect(saved).toEqual({ ok: true, payoutIgnored: 'existing' });
    expect((await stored(noa)).payoutAddressMasked).toBe('ES91 •••• •••• 1332');
    const submitted = (await auditOf(noa)).find((a) => a.action === 'operator.self_onboarding.submitted')!;
    expect(submitted.payload).toMatchObject({
      payoutIgnored: 'existing',
      proposedPayout: { method: 'SEPA_IBAN', address: 'ES79 •••• •••• 6789', metadata: { accountHolder: 'O••• P•••' } },
    });
    expect(JSON.stringify(submitted)).not.toContain(IBAN2);
    expect(JSON.stringify(submitted)).not.toContain('Persona');
  });
});

describe('el relleno: cifra lo que estaba en claro, se puede repetir y no cuenta como un cambio de cuenta', () => {
  let wire: string;
  let crypto: string;
  let payoutId: string;
  let before: Stored;

  it('mientras no se lanza, el API lee las cuentas antiguas en claro sin romperse (y las tapa)', async () => {
    wire = await newChica('Camila', {
      payoutMethod: 'WIRE_INTERNATIONAL',
      payoutAddress: 'GE29NB0000000101904917',
      payoutMetadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22', accountHolder: 'Camila Rodriguez' },
      payoutLabel: 'TBC',
    });
    crypto = await newChica('Kira', { payoutMethod: 'USDT_TRC20', payoutAddress: TRON });
    before = await stored(wire);

    const list = await asStaff(V, () => admin.listOperators(V));
    expect(list.find((o) => o.id === wire)).toMatchObject({
      payoutAddressMasked: 'GE29 •••• •••• 4917',
      payoutHolderMasked: 'C••• R•••',
      payoutMetadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22' },
    });
    expect(JSON.stringify(list)).not.toContain('GE29NB0000000101904917');
    expect(JSON.stringify(list)).not.toContain('Rodriguez');
    expect((await asStaff(V, () => operators.getMyPayoutInfo(crypto, V))).account).toMatchObject({ masked: 'T…uFiV' });
    expect((await reveal(boss, 'OWNER', wire, { totpCode: await codeOf(boss) })).payoutAddress).toBe('GE29NB0000000101904917');

    // Un pago de antes, con la cuenta en claro en el propio pago.
    await newEarning(crypto, 10_000);
    payoutId = (await markPaid(boss, 'OWNER', crypto, { externalRail: 'USDT_TRC20', externalTxId: uniq('hash'), totpCode: await codeOf(boss) })).id;
    await sys((tx) => tx.$executeRaw`UPDATE operator_payouts SET "paidToAddress" = ${TRON} WHERE id = ${payoutId}::uuid`);
  });

  it('lanzado: cuentas, titulares y pagos quedan cifrados y tapados; ni fechas, ni espera, ni avisos, ni correo', async () => {
    const mailsBefore = sent.length;
    const done = await asPublic(() => backfill.run());
    expect(done.failed).toBe(0);
    expect(done.accounts).toBeGreaterThanOrEqual(2);
    expect(done.payouts).toBeGreaterThanOrEqual(1);

    const row = await stored(wire);
    expect(row.payoutAddress).toMatch(/^pa1:/);
    expect(row.payoutMetadata).toMatchObject({ bankName: 'TBC Bank', accountHolder: expect.stringMatching(/^pa1:/) });
    expect(row).toMatchObject({ payoutAddressMasked: 'GE29 •••• •••• 4917', payoutHolderMasked: 'C••• R•••', payoutAccountChangedAt: null, payoutHoldUntil: null });
    expect(row.updatedAt).toEqual(before.updatedAt);
    const raw = `${await rawUser(wire)}${await rawUser(crypto)}`;
    expect(raw).not.toContain('GE29NB0000000101904917');
    expect(raw).not.toContain('Rodriguez');
    expect(raw).not.toContain(TRON);
    expect((await payoutsOf(crypto))[0]!.paidToAddress).toMatch(/^pa1:/);

    expect(sent.length).toBe(mailsBefore);
    expect(await asStaff(V, () => operators.getPayoutNotice(wire, V))).toBeNull();
    expect((await auditOf(wire)).filter((a) => a.action === 'operator.payout_account_changed')).toEqual([]);
  });

  it('después se lee igual: tapada en el panel, entera con «Ver cuenta», y el pago se verifica contra la misma dirección', async () => {
    const view = (await asStaff(V, () => admin.listOperators(V))).find((o) => o.id === wire)!;
    expect(view).toMatchObject({ payoutAddressMasked: 'GE29 •••• •••• 4917', payoutHolderMasked: 'C••• R•••', payoutHolderMismatch: false });
    const full = await reveal(boss, 'OWNER', wire, { totpCode: await codeOf(boss) });
    expect(full).toMatchObject({
      payoutAddress: 'GE29NB0000000101904917',
      payoutLabel: 'TBC',
      payoutMetadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22', accountHolder: 'Camila Rodriguez' },
    });

    const hash = (await sys<{ externalTxId: string }>((tx) => tx.operatorPayout.findUniqueOrThrow({ where: { id: payoutId } }))).externalTxId;
    await asStaff(V, () => treasury.verifyPayout(V, payoutId, boss, { externalTxId: hash, externalRail: 'USDT_TRC20' } as never));
    expect(verifiedAgainst.at(-1)).toBe(TRON);
  });

  it('otra vez: no queda nada por cifrar y no toca nada', async () => {
    const rowBefore = await stored(wire);
    expect(await asPublic(() => backfill.run())).toEqual({ accounts: 0, payouts: 0, failed: 0 });
    expect(await stored(wire)).toEqual(rowBefore);
    expect(await backfill.leftInClear()).toBe(0);
  });

  it('al arrancar el API se lanza solo, sin hacer esperar al arranque; si falla, no lo impide', async () => {
    const eli = await newChica('Eli', { payoutMethod: 'USDT_TRC20', payoutAddress: TRON });
    // Lo que queda en claro se cuenta (es lo que el arranque avisa si no baja a cero): la cuenta de Eli y el titular de Sol.
    await newChica('Sol', { payoutMethod: 'SEPA_IBAN', payoutMetadata: { accountHolder: 'Sol Vega' } });
    expect(await backfill.leftInClear()).toBe(2);
    // Como en el arranque: sin petición ni local en el contexto.
    await backfill.runLogged();
    expect((await stored(eli)).payoutAddress).toMatch(/^pa1:/);
    expect(await backfill.leftInClear()).toBe(0);

    // El arranque no lo espera: con la base sin contestar, vuelve al momento.
    const stuck = new PayoutAccountBackfill({ asSystem: () => new Promise(() => undefined) } as never);
    expect(stuck.onApplicationBootstrap()).toBeUndefined();
    const broken = new PayoutAccountBackfill({ asSystem: async () => Promise.reject(new Error('base caída')) } as never);
    expect(broken.onApplicationBootstrap()).toBeUndefined();
    await expect(broken.runLogged()).resolves.toBeUndefined();
  });

  it('una cuenta cambiada mientras se rellenaba no se pisa (se cifra lo que hay ahora, no lo que se leyó)', async () => {
    const zoe = await newChica('Zoe', { payoutMethod: 'USDT_TRC20', payoutAddress: TRON });
    const racing = new PayoutAccountBackfill(prisma);
    // Entre leerla y escribirla, el dueño la cambia.
    const sealAccount = (racing as unknown as { sealAccount: (...a: unknown[]) => Promise<boolean> }).sealAccount.bind(racing);
    (racing as unknown as { sealAccount: unknown }).sealAccount = async (...a: unknown[]) => {
      if ((a[0] as { id: string }).id === zoe) {
        await patch(boss, 'OWNER', zoe, { payoutMethod: 'USDT_BEP20', payoutAddress: '0x55d398326f99059ff775485246999027b3197955', totpCode: await codeOf(boss) });
      }
      return sealAccount(...a);
    };
    await asPublic(() => racing.run());
    expect((await stored(zoe)).payoutAddressMasked).toBe('0x…7955');
    expect((await reveal(boss, 'OWNER', zoe, { totpCode: await codeOf(boss) })).payoutAddress).toBe('0x55d398326f99059ff775485246999027b3197955');
  });
});
