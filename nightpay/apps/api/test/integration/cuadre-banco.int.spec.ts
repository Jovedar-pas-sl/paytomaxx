// Integración (Postgres real): cuadre con el fichero del banco e Incidencias. Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { BankReconService } from '../../src/modules/bank-recon/bank-recon.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';

const cls = new ClsService(new AsyncLocalStorage());
 
const prisma = new PrismaService(cls as any);
const audit = { log: async () => undefined };
const svc = new BankReconService(prisma as never, audit as never);
const incidents = new IncidentsService(prisma as never, audit as never);

function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
}
function asSystemCtx<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    return fn();
  });
}

const r = randomUUID().slice(0, 6);
let A: string, B: string, owner: string, termA: string, termB: string;
const ids: Record<string, string> = {};

const CSV = [
  'Fecha;Hora;Tipo operación;Cód. pedido;Resultado operación y código;Importe;Moneda;Importe Euros;Tipo de pago;Tipo pago original;N.º tarjeta;Titular;',
  `12/10/2026;23:18:59;Autorización;ORD${r}1;Autorizada 741936;60.00;EUR;60.00;Visa;;415006******2715;;`,
  `12/10/2026;23:30:00;Autorización;ORD${r}3;Autorizada 555555;45.00;EUR;45.00;Visa;;;;`,
  `12/10/2026;23:40:00;Autorización;ZZZ${r};Autorizada 777777;10.00;EUR;10.00;Visa;;;;`,
  `12/10/2026;23:50:00;Autorización;ORD${r}9;Denegada 190;99.00;EUR;99.00;Visa;;;;`,
  `12/10/2026;23:55:00;Devolución;ORD${r}1;Autorizada 098692;20;EUR;20;;;;;`,
].join('\r\n');

const madrid = (iso: string) => new Date(iso); // ya en UTC

beforeAll(async () => {
  await prisma.onModuleInit();
  await asSystemCtx(() =>
    prisma.asSystem(async (tx) => {
      A = (await tx.venue.create({ data: { name: 'Local A', slug: `ba-${r}`, walletGroup: `g-${r}` } })).id;
      B = (await tx.venue.create({ data: { name: 'Local B', slug: `bb-${r}`, walletGroup: `g-${r}` } })).id;
      owner = (await tx.user.create({ data: { tenantId: A, email: `own-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      termA = (await tx.terminal.create({ data: { tenantId: A, externalId: `TA-${r}`, label: 'A' } })).id;
      termB = (await tx.terminal.create({ data: { tenantId: B, externalId: `TB-${r}`, label: 'B' } })).id;
      const pay = async (
        key: string,
        o: { tenantId: string; terminalId: string; status: string; amount: number; tip?: number; ref: string; at: string },
      ) => {
        const p = await tx.payment.create({
          data: {
            tenantId: o.tenantId,
            terminalId: o.terminalId,
            idempotencyKey: `${key}-${r}`,
            amountCents: o.amount,
            tipCents: o.tip ?? 0,
            availableAmountCents: o.amount,
            qrToken: `qr-${key}-${r}`,
            qrExpiresAt: new Date('2026-10-13T00:00:00Z'),
            status: o.status as never,
            provider: 'REDSYS',
            providerTxId: o.ref,
            authorizedAt: o.status === 'AUTHORIZED' || o.status === 'PARTIALLY_REFUNDED' ? madrid(o.at) : null,
          },
        });
        await tx.paymentAttempt.create({
          data: {
            paymentId: p.id,
            tenantId: o.tenantId,
            provider: 'REDSYS',
            providerTxId: o.ref,
            status: o.status === 'ORPHAN' ? 'PENDING' : 'APPROVED',
            amountCents: o.amount + (o.tip ?? 0),
          },
        });
        ids[key] = p.id;
      };
      // Cuadra (5.500 + 500 de propina = 60 €) y tiene una devolución de 20 € apuntada.
      await pay('p1', { tenantId: A, terminalId: termA, status: 'PARTIALLY_REFUNDED', amount: 5500, tip: 500, ref: `ORD${r}1`, at: '2026-10-12T21:18:30Z' });
      // Pagado aquí, el banco no lo tiene.
      await pay('p2', { tenantId: B, terminalId: termB, status: 'AUTHORIZED', amount: 3000, ref: `ORD${r}2`, at: '2026-10-12T21:20:00Z' });
      // El banco lo cobró y aquí quedó sin pagar (aviso perdido).
      await pay('p3', { tenantId: B, terminalId: termB, status: 'ORPHAN', amount: 4500, ref: `ORD${r}3`, at: '2026-10-12T21:30:00Z' });
      const ref = await tx.refund.create({
        data: {
          tenantId: A,
          paymentId: ids.p1!,
          amountCents: 2000,
          requestedBy: owner,
          status: 'SUCCEEDED',
          registeredManually: true,
          bankRefundedAt: madrid('2026-10-12T21:55:00Z'),
        },
      });
      ids.r1 = ref.id;
    }),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('cuadre con el banco contra Postgres real', () => {
  let firstId = '';

  it('importa el fichero de Redsys y clasifica cada línea (grupo de locales A+B)', async () => {
    const out = await asTenant(A, () =>
      svc.importStatement(
        { userId: owner, role: 'OWNER', tenantId: A },
        { source: 'REDSYS', fileName: 'canales.csv', content: Buffer.from(CSV, 'utf8') },
        new Date('2026-10-14T09:00:00Z'),
      ),
    );
    firstId = out.id;
    expect(out).toMatchObject({ periodFrom: '2026-10-12', periodTo: '2026-10-12', rowsTotal: 5, problemCount: 3 });
    // Banco: 60 + 45 + 10 − 20 = 95; aquí: 60 + 30 − 20 = 70.
    expect(out).toMatchObject({ bankTotalCents: 9500, oursTotalCents: 7000 });

    const { items } = await asTenant(A, () => svc.detail({ userId: owner, role: 'OWNER', tenantId: A }, out.id));
    const byStatus = Object.fromEntries(items.map((i) => [i.status, i]));
    expect(Object.keys(byStatus).sort()).toEqual(
      ['MATCHED', 'NOT_IN_BANK', 'NOT_IN_OXIOPAY', 'NOT_PAID_HERE', 'REFUND_MATCHED'].sort(),
    );
    expect(byStatus.NOT_IN_BANK).toMatchObject({ paymentId: ids.p2, venueName: 'Local B' });
    expect(byStatus.NOT_PAID_HERE).toMatchObject({ paymentId: ids.p3, venueName: 'Local B' });
    expect(byStatus.NOT_IN_OXIOPAY).toMatchObject({ venueName: 'Local A' });
  });

  it('sale en Incidencias de cada local; lo de "cobrado y aquí sin pagar" se quita al resolverlo', async () => {
    const inB = await asTenant(B, () => incidents.list(B, new Date('2026-10-14T09:00:00Z')));
    const bankB = inB.filter((i) => i.kind === 'bank_mismatch').map((i) => i.title);
    expect(bankB.sort()).toEqual(['Cobro que el banco no tiene', 'El banco cobró un pago que aquí no consta como pagado'].sort());

    await asSystemCtx(() =>
      prisma.asSystem((tx) =>
        tx.payment.update({ where: { id: ids.p3! }, data: { status: 'AUTHORIZED', authorizedAt: new Date('2026-10-12T21:30:00Z') } }),
      ),
    );
    const after = await asTenant(B, () => incidents.list(B, new Date('2026-10-14T09:00:00Z')));
    expect(after.filter((i) => i.kind === 'bank_mismatch').map((i) => i.title)).toEqual(['Cobro que el banco no tiene']);
  });

  it('subir otra vez esos días sustituye el cuadre anterior (sin avisos repetidos)', async () => {
    const second = await asTenant(A, () =>
      svc.importStatement(
        { userId: owner, role: 'OWNER', tenantId: A },
        { source: 'REDSYS', fileName: 'canales2.csv', content: Buffer.from(CSV, 'utf8') },
        new Date('2026-10-14T09:05:00Z'),
      ),
    );
    // p3 ya está pagado: ahora cuadra; quedan "solo en el banco" y "falta en el banco".
    expect(second.problemCount).toBe(2);
    expect(second).toMatchObject({ skippedCount: 0, otherCount: 0 });
    const list = await asTenant(A, () => svc.list({ userId: owner, role: 'OWNER', tenantId: A }));
    expect(list.find((s) => s.id === firstId)?.superseded).toBe(true);
    const inB = await asTenant(B, () => incidents.list(B, new Date('2026-10-14T09:10:00Z')));
    expect(inB.filter((i) => i.kind === 'bank_mismatch')).toHaveLength(1);
    const inA = await asTenant(A, () => incidents.list(A, new Date('2026-10-14T09:10:00Z')));
    expect(inA.filter((i) => i.kind === 'bank_mismatch')).toHaveLength(1);
  });

  it('lo marcado como revisado sigue revisado al volver a subir el fichero', async () => {
    const before = await asTenant(B, () => incidents.list(B, new Date('2026-10-14T09:10:00Z')));
    const target = before.find((i) => i.kind === 'bank_mismatch')!;
    await asTenant(B, () => incidents.ack(B, owner, { kind: 'bank_mismatch', refId: target.refId }));
    await asTenant(A, () =>
      svc.importStatement(
        { userId: owner, role: 'OWNER', tenantId: A },
        { source: 'REDSYS', fileName: 'canales3.csv', content: Buffer.from(CSV, 'utf8') },
        new Date('2026-10-14T09:20:00Z'),
      ),
    );
    const after = await asTenant(B, () => incidents.list(B, new Date('2026-10-14T09:25:00Z')));
    expect(after.filter((i) => i.kind === 'bank_mismatch')).toHaveLength(0);
  });

  it('un encargado no puede; un fichero sin columnas se explica', async () => {
    await expect(
      asTenant(A, () =>
        svc.importStatement({ userId: owner, role: 'MANAGER', tenantId: A }, {
          source: 'REDSYS',
          fileName: 'x.csv',
          content: Buffer.from(CSV, 'utf8'),
        }),
      ),
    ).rejects.toThrow(/dueño/);
    await expect(
      asTenant(A, () =>
        svc.importStatement({ userId: owner, role: 'OWNER', tenantId: A }, {
          source: 'REDSYS',
          fileName: 'x.csv',
          content: Buffer.from('hola;adios\n1;2', 'utf8'),
        }),
      ),
    ).rejects.toThrow(/No encuentro las columnas/);
  });
});
