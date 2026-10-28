import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { CobrosQuerySchema, confirmationCode } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { cobrosCsv } from '../../src/modules/reports/export-csv';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const cobros = new CobrosService(prisma);
const reports = new ReportsService(prisma);
const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> => cls.run(async () => {
  cls.set('ctx', { tenantId, traceId: 'h' }); return fn();
});
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => inVenue(undefined, () => prisma.asSystem(fn));
const key = randomUUID().slice(0, 8);
let a: string, b: string, id: string;
const approved = 'BBVA' + key.toUpperCase();
const denied = 'OTRO' + key.toUpperCase();
beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async tx => {
    a = (await tx.venue.create({data: {name:'Local H', slug:'ha-'+key}})).id;
    b = (await tx.venue.create({data: {name:'Otro local', slug:'hb-'+key}})).id;
    const u = await tx.user.create({data: {tenantId:a,email:key+'@test.invalid',passwordHash:'x',role:'OWNER'}});
    const t = await tx.terminal.create({data: {tenantId:a,externalId:'h-'+key,label:'Barra'}});
    const p = await tx.payment.create({data:{tenantId:a,terminalId:t.id,createdByUserId:u.id,idempotencyKey:'h-'+key,qrToken:'h-'+key,qrExpiresAt:new Date(Date.now()+3600000),amountCents:1000,availableAmountCents:1000,status:'AUTHORIZED',provider:'REDSYS',providerTxId:denied,authCode:'011234',authorizedAt:new Date(),revenueCategory:'VENUE_BAR'}});
    id=p.id;
    await tx.paymentAttempt.create({data:{tenantId:a,paymentId:id,provider:'REDSYS',providerTxId:approved,status:'APPROVED'}});
    await tx.paymentAttempt.create({data:{tenantId:a,paymentId:id,provider:'REDSYS',providerTxId:denied,status:'DENIED'}});
  });
});
afterAll(async () => prisma.$disconnect());

describe('referencias del panel con base real', () => {
  const find = (tenantId:string, search:string) => inVenue(tenantId, () => cobros.list(tenantId, CobrosQuerySchema.parse({search,limit:50})));
  it('encuentra el cobro antiguo por código, pedido aprobado y autorización, sin mezclar locales', async () => {
    for (const search of [confirmationCode(id).toLowerCase(), approved.toLowerCase(), '011234']) {
      const result = await find(a, search);
      expect(result.items.map(x => x.id)).toContain(id);
      expect((await find(b, search)).items.map(x => x.id)).not.toContain(id);
    }
  });
  it('la búsqueda no devuelve cobros que no coinciden ni el pedido denegado', async () => {
    expect((await find(a, 'referencia-que-no-existe')).items).toEqual([]);
    expect((await find(a, denied)).items.map(x => x.id)).not.toContain(id);
  });
  it('en lista y CSV utiliza el pedido aprobado y mantiene los intentos', async () => {
    const result = await find(a, approved);
    const row = result.items.find(x=>x.id===id)!;
    expect(row.confirmationCode).toBe(confirmationCode(id));
    expect(row.payment?.providerTxId).toBe(approved);
    expect(row.payment?.attempts).toHaveLength(2);
    const rows = await inVenue(a, () => reports.cobros(a, {from:new Date(Date.now()-60000),to:new Date(Date.now()+60000)}));
    const report = rows.find(x=>x.id===id)!;
    expect(report.providerTxId).toBe(approved);
    const csv = cobrosCsv([report], 'Local H');
    expect(csv).toContain(confirmationCode(id));
    expect(csv).toContain(approved);
    expect(csv).toContain('011234');
  });
});
