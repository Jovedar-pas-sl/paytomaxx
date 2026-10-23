// Integración (Postgres real, FORCE RLS, TENANCY_UNSCOPED_QUERIES=throw): cierre de la noche en pasos con
// el arqueo de caja. Cada prueba entra como el personal del local (local en el contexto, como tras
// AuthGuard); los datos se siembran aparte. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, type HttpException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { NightCloseStep } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: async () => undefined };
// Sin días de espera del entorno: cuenta el de cada local (0 o 7).
const config = { get: () => undefined, getOrThrow: () => undefined };
const reports = new ReportsService(prisma);
const incidents = new IncidentsService(prisma, audit as never);
const checks = new CloseCheckService(prisma, incidents, config as never);
const nights = new NightsService(prisma, reports, audit as never, checks);
// Las pruebas abren noches «hace 2-3 h»: entre las 08:00 y las 11:00 de Madrid el
// cierre automático las cerraría antes de comprobarlas. Se apaga aquí y la última
// prueba (la del cierre automático) lo vuelve a encender.
const autoClose = vi
  .spyOn(nights as unknown as { safeAutoClose(tenantId: string): Promise<void> }, 'safeAutoClose')
  .mockResolvedValue(undefined);
const operators = new OperatorsService(prisma, audit as never, audit as never, config as never, {} as never, {} as never);
const charges = new WalletChargesService(prisma, audit as never, { get: () => null } as never);

/** Una petición del panel de ese local (como tras AuthGuard). */
function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
/** Sembrar datos (sin local en el contexto, con bypass). */
function seed<T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-seed' });
    return prisma.asSystem(fn);
  });
}

/**
 * La hora de la base (now() de Postgres: la de un pago recién apuntado) puede
 * ir unos ms por delante de la de Node (el «hasta ahora» de los pasos del
 * cierre): antes de mirarlos, se espera un poco.
 */
const dbClockAhead = () => new Promise((resolve) => setTimeout(resolve, 50));

const r = randomUUID().slice(0, 6);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
let k = 0;

interface Local {
  id: string;
  owner: string;
  manager: string;
  chica: string;
  term: string;
}

async function seedLocal(tag: string, payoutHoldDays: number): Promise<Local> {
  return seed(async (tx) => {
    const id = (
      await tx.venue.create({ data: { name: `Local ${tag}`, slug: `cn-${tag}-${r}`, walletGroup: `gcn-${tag}-${r}`, payoutHoldDays } })
    ).id;
    const user = (role: 'OWNER' | 'MANAGER' | 'OPERATOR', extra: Record<string, unknown> = {}) =>
      tx.user.create({ data: { tenantId: id, email: `${role.toLowerCase()}-${tag}-${r}@x.es`, passwordHash: 'x', role, ...extra } as never });
    const owner = (await user('OWNER')).id;
    const manager = (await user('MANAGER')).id;
    const chica = (await user('OPERATOR', { displayName: `Lola ${tag}`, payoutMethod: 'MANUAL_CASH' })).id;
    const term = (await tx.terminal.create({ data: { tenantId: id, externalId: `TCN-${tag}-${r}`, label: `Barra ${tag}` } })).id;
    return { id, owner, manager, chica, term };
  });
}

/** Un cobro de la chica (con su comisión del 90 %) o del local, pagado `at`. */
async function charge(l: Local, amountCents: number, o: { at?: Date; chica?: boolean; status?: string } = {}) {
  const at = o.at ?? new Date();
  const status = o.status ?? 'AUTHORIZED';
  return seed(async (tx) => {
    const n = k++;
    const p = await tx.payment.create({
      data: {
        tenantId: l.id, terminalId: l.term, idempotencyKey: `cn-${r}-${n}`, qrToken: `cn-${r}-${n}`, qrExpiresAt: new Date(Date.now() + HOUR),
        amountCents, availableAmountCents: amountCents, status, provider: 'REDSYS', providerTxId: `CN${r}${n}`,
        createdByUserId: o.chica ? l.chica : null, revenueCategory: o.chica ? 'CHICA_SERVICE' : 'VENUE_BAR',
        createdAt: at, ...(status === 'AUTHORIZED' ? { authorizedAt: at } : {}),
      } as never,
    });
    if (o.chica && status === 'AUTHORIZED') {
      await tx.operatorEarning.create({
        data: {
          tenantId: l.id, operatorId: l.chica, paymentId: p.id, paymentAmountCents: amountCents, commissionBps: 9000,
          commissionCents: Math.round(amountCents * 0.9), createdAt: at,
        },
      });
    }
    return p;
  });
}

function stepOf(steps: NightCloseStep[], key: NightCloseStep['key']): NightCloseStep {
  return steps.find((s) => s.key === key)!;
}

/** El cuerpo del error (código, pasos y lo que falta); por defecto, un 409. */
async function refusal(
  p: Promise<unknown>,
  kind: typeof ConflictException | typeof BadRequestException = ConflictException,
): Promise<{ code: string; missing: string[]; steps: NightCloseStep[] }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(kind);
  return (err as HttpException).getResponse() as never;
}

let caja: Local; // se paga al cierre (0 días)
let espera: Local; // 7 días de espera
let night0: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  caja = await seedLocal('caja', 0);
  espera = await seedLocal('espera', 7);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('cierre de la noche con arqueo de caja (Postgres real)', () => {
  it('cobros, saldo devuelto en efectivo, pago en efectivo a la chica y fondo → efectivo esperado', async () => {
    // El encargado abre la noche con 200 € de fondo.
    const opened = await asStaff(caja.id, () => nights.open(caja.id, caja.manager, 20_000));
    night0 = opened.id;
    expect(opened.openingFloatCents).toBe(20_000);

    await charge(caja, 10_000, { chica: true }); // 100 € de la chica: 90 € para ella
    await charge(caja, 3000); // 30 € de barra
    // Un cliente pulsa «Me voy» y el encargado le devuelve 45 € en efectivo.
    const wallet = await seed((tx) =>
      tx.clientWallet.create({
        data: { tenantId: caja.id, balanceCents: 4500, qrToken: `cnw-${r}`, shortCode: `W${r}`.slice(0, 6).toUpperCase(), walletGroup: `gcn-caja-${r}`, closeRequestedAt: new Date() },
      }),
    );
    // Lo cargó en efectivo otro día (en efectivo solo se devuelve lo que entró en efectivo).
    await seed((tx) =>
      tx.walletCashTopUp.create({
        data: { tenantId: caja.id, walletId: wallet.id, amountCents: 4500, takenByUserId: caja.manager, idempotencyKey: `cn-${r}`, createdAt: new Date(Date.now() - 86_400_000) },
      }),
    );
    // Antes de devolverlo, el paso del saldo lo avisa.
    const before = await asStaff(caja.id, () => nights.closeCheck(caja.id));
    expect(stepOf(before.steps, 'saldo')).toMatchObject({ status: 'warn', count: 1 });
    expect(stepOf(before.steps, 'chicas')).toMatchObject({ status: 'warn', count: 1 });
    expect(before.chicas).toEqual([expect.objectContaining({ operatorId: caja.chica, toPayCents: 9000, earnedTonightCents: 9000 })]);

    await asStaff(caja.id, () =>
      charges.payout({ userId: caja.manager, tenantId: caja.id, role: 'MANAGER' }, wallet.id, { method: 'CASH' }),
    );
    // Se le paga a la chica al cierre, en efectivo (lo que dice la lista).
    const paid = await asStaff(caja.id, () =>
      operators.createPayout(caja.id, caja.chica, caja.owner, 'al cierre', { externalRail: 'MANUAL_CASH' }),
    );
    expect(paid.totalCents).toBe(9000);

    await dbClockAhead();
    const check = await asStaff(caja.id, () => nights.closeCheck(caja.id));
    expect(check.cash).toEqual({
      openingFloatCents: 20_000,
      cashInCents: 0,
      walletCashTopUpsCount: 0,
      walletCashTopUpsCents: 0,
      walletCashPayoutsCount: 1,
      walletCashPayoutsCents: 4500,
      chicaCashPayoutsCount: 1,
      chicaCashPayoutsCents: 9000,
      // Los pagos en efectivo a los camareros, aparte (aquí, ninguno).
      camareroCashPayoutsCount: 0,
      camareroCashPayoutsCents: 0,
      cashOutCents: 13_500,
      expectedCents: 6500,
    });
    expect(check.steps.map((s) => [s.key, s.status])).toEqual([
      ['cobros', 'ok'],
      ['datafonos', 'ok'],
      ['saldo', 'ok'],
      ['efectivo', 'block'], // falta contar la caja
      ['chicas', 'ok'],
      ['incidencias', 'ok'],
      ['z', 'ok'],
    ]);
    expect(stepOf(check.steps, 'efectivo').detail).toContain('debería haber 65,00 €');
    expect(check.chicas).toEqual([
      expect.objectContaining({ toPayCents: 0, paidTonightCents: 9000, paidTonightCount: 1, earnedTonightCents: 9000 }),
    ]);
  });

  it('contado ≠ esperado: hay que confirmarlo y la diferencia queda congelada en el Z', async () => {
    // Sin contar, no: el paso del efectivo bloquea.
    const blocked = await refusal(asStaff(caja.id, () => nights.close(caja.id, { userId: caja.manager, role: 'MANAGER' }, night0)));
    expect(blocked).toMatchObject({ code: 'NIGHT_CLOSE_BLOCKED', missing: ['efectivo'] });

    // Contado 60 €: faltan 5 € y hay que confirmarlo.
    const needsAck = await refusal(
      asStaff(caja.id, () => nights.close(caja.id, { userId: caja.manager, role: 'MANAGER' }, night0, { cashCountedCents: 6000 })),
    );
    expect(needsAck).toMatchObject({ code: 'NIGHT_CLOSE_NEEDS_ACK', missing: ['efectivo'] });

    const closed = await asStaff(caja.id, () =>
      nights.close(caja.id, { userId: caja.manager, role: 'MANAGER' }, night0, {
        cashCountedCents: 6000,
        acknowledged: ['efectivo'],
        cashNote: 'faltan 5 € del cambio',
      }),
    );
    expect(closed.closedAt).not.toBeNull();
    expect(closed.z.caja).toMatchObject({
      openingFloatCents: 20_000,
      walletCashPayoutsCents: 4500,
      chicaCashPayoutsCents: 9000,
      expectedCents: 6500,
      countedCents: 6000,
      diffCents: -500,
      note: 'faltan 5 € del cambio',
    });
    // El resto del Z cuenta lo mismo: 130 € cobrados, 45 € devueltos en efectivo, 90 € pagados.
    expect(closed.z.summary).toMatchObject({ chargedCents: 13_000, walletCashPayoutsCents: 4500, payoutsCents: 9000 });

    const row = await seed((tx) => tx.venueNight.findUnique({ where: { id: night0 } }));
    expect(row).toMatchObject({ openingFloatCents: 20_000, cashExpectedCents: 6500, cashCountedCents: 6000, cashDiffCents: -500 });
    const list = await asStaff(caja.id, () => nights.list(caja.id));
    expect(list[0]).toMatchObject({ id: night0, cashDiffCents: -500 });
    // Congelado: verlo otra vez no lo recalcula.
    expect((await asStaff(caja.id, () => nights.get(caja.id, night0))).z.caja).toEqual(closed.z.caja);
  });

  it('un cobro esperando al banco hace menos de 15 min bloquea el cierre, aunque se confirme todo', async () => {
    const night = await seed((tx) => tx.venueNight.create({ data: { tenantId: espera.id, openedAt: ago(2 * HOUR), openedBy: espera.manager } }));
    const paying = await charge(espera, 4000, { status: 'AUTHORIZING' });
    const check = await asStaff(espera.id, () => nights.closeCheck(espera.id));
    expect(stepOf(check.steps, 'cobros')).toMatchObject({ status: 'block', count: 1 });
    expect(stepOf(check.steps, 'cobros').detail).toMatch(/espera o resuélvelo/);

    const body = await refusal(
      asStaff(espera.id, () =>
        nights.close(espera.id, { userId: espera.manager, role: 'MANAGER' }, night.id, {
          acknowledged: ['cobros', 'datafonos', 'saldo', 'efectivo', 'chicas', 'incidencias', 'z'],
          note: 'cierro ya',
        }),
      ),
    );
    expect(body.code).toBe('NIGHT_CLOSE_BLOCKED');
    expect(body.missing).toEqual(['cobros']);
    expect(body.steps).toHaveLength(7);
    expect((await seed((tx) => tx.venueNight.findUnique({ where: { id: night.id } })))!.closedAt).toBeNull();

    // Pasados 15 min ya no está pagando: está atascado (aviso, se puede cerrar confirmándolo).
    await seed((tx) => tx.$executeRaw`UPDATE payments SET "updatedAt" = ${ago(20 * MIN)} WHERE id = ${paying.id}::uuid`);
  });

  it('los avisos hay que confirmarlos; con cobros sin terminar, además, la nota', async () => {
    const actor = { userId: espera.manager, role: 'MANAGER' };
    const open = await asStaff(espera.id, () => nights.current(espera.id));
    const check = await asStaff(espera.id, () => nights.closeCheck(espera.id));
    // El cobro atascado sale en «Cobros sin terminar» y en Incidencias.
    expect(stepOf(check.steps, 'cobros')).toMatchObject({ status: 'warn' });
    expect(stepOf(check.steps, 'incidencias')).toMatchObject({ status: 'warn', count: 1 });
    expect(stepOf(check.steps, 'efectivo')).toMatchObject({ status: 'ok' }); // sin efectivo ni fondo

    const ack = await refusal(asStaff(espera.id, () => nights.close(espera.id, actor, open!.id, { acknowledged: ['cobros'] })));
    expect(ack).toMatchObject({ code: 'NIGHT_CLOSE_NEEDS_ACK', missing: ['incidencias'] });

    const note = await refusal(
      asStaff(espera.id, () => nights.close(espera.id, actor, open!.id, { acknowledged: ['cobros', 'incidencias'] })),
      BadRequestException,
    );
    expect(note.code).toBe('NIGHT_CLOSE_NOTE_REQUIRED');

    const closed = await asStaff(espera.id, () =>
      nights.close(espera.id, actor, open!.id, { acknowledged: ['cobros', 'incidencias'], note: 'BBVA lo confirma mañana' }),
    );
    expect(closed).toMatchObject({ pendingAtClose: 1, closeNote: 'BBVA lo confirma mañana' });
    // Sin efectivo: la caja va al Z sin contar.
    expect(closed.z.caja).toMatchObject({ expectedCents: 0, countedCents: null, diffCents: null });
  });

  it('la lista de las chicas respeta los días de espera: 0 = todo al cierre, 7 = lo de esta noche espera', async () => {
    const cero = await seedLocal('cero', 0);
    const siete = await seedLocal('siete', 7);
    for (const l of [cero, siete]) {
      await seed((tx) => tx.venueNight.create({ data: { tenantId: l.id, openedAt: ago(3 * HOUR), openedBy: l.manager } }));
      await charge(l, 2000, { chica: true, at: ago(30 * DAY) }); // 18 € de hace un mes
      await charge(l, 10_000, { chica: true, at: ago(HOUR) }); // 90 € de esta noche
    }

    const atClose = await asStaff(cero.id, () => nights.closeCheck(cero.id));
    expect(atClose.holdDays).toBe(0);
    expect(atClose.chicas).toEqual([
      expect.objectContaining({ operatorId: cero.chica, toPayCents: 10_800, heldCents: 0, earnedTonightCents: 9000 }),
    ]);
    expect(stepOf(atClose.steps, 'chicas')).toMatchObject({ status: 'warn', count: 1 });
    expect(stepOf(atClose.steps, 'chicas').items[0]!.label).toBe('Lola cero: Págale 108,00 €');

    const held = await asStaff(siete.id, () => nights.closeCheck(siete.id));
    expect(held.holdDays).toBe(7);
    expect(held.chicas).toEqual([
      expect.objectContaining({ operatorId: siete.chica, toPayCents: 1800, heldCents: 9000, earnedTonightCents: 9000 }),
    ]);
    expect(stepOf(held.steps, 'chicas').detail).toContain('90,00 € siguen en espera: se pagan pasados 7 días');

    // «Pagar» paga justo lo que dice la lista.
    const paid = await asStaff(siete.id, () =>
      operators.createPayout(siete.id, siete.chica, siete.owner, undefined, { externalRail: 'MANUAL_CASH' }),
    );
    expect(paid.totalCents).toBe(1800);
    await dbClockAhead();
    const after = await asStaff(siete.id, () => nights.closeCheck(siete.id));
    expect(after.chicas[0]).toMatchObject({ toPayCents: 0, heldCents: 9000, paidTonightCents: 1800 });
    expect(stepOf(after.steps, 'chicas').status).toBe('ok');
    // Y ese pago en efectivo ya cuenta en la caja (sin fondo: hay que decirlo al cerrar).
    expect(after.cash).toMatchObject({ chicaCashPayoutsCents: 1800, expectedCents: -1800 });
    expect(stepOf(after.steps, 'efectivo')).toMatchObject({ status: 'block', detail: expect.stringContaining('fondo') });
  });

  it('la noche que nadie cierra se cierra sola con la caja sin contar', async () => {
    autoClose.mockRestore();
    const solo = await seedLocal('sola', 0);
    // Abierta hace 36 h con 100 € de fondo: a las 08:00 siguientes se cerró sola.
    const night = await seed((tx) =>
      tx.venueNight.create({ data: { tenantId: solo.id, openedAt: ago(DAY + 12 * HOUR), openingFloatCents: 10_000 } }),
    );
    await asStaff(solo.id, () => nights.current(solo.id));
    const row = await seed((tx) => tx.venueNight.findUnique({ where: { id: night.id } }));
    expect(row).toMatchObject({ autoClosed: true, cashExpectedCents: 10_000, cashCountedCents: null, cashDiffCents: null });
    expect((row!.zReport as { caja?: unknown }).caja).toMatchObject({ openingFloatCents: 10_000, expectedCents: 10_000, countedCents: null });
  });
});
