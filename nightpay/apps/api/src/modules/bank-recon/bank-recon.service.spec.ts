import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BankReconService, referenceVariants } from './bank-recon.service';

/**
 * Cuadre con el banco: lo que hace el servicio con el fichero ya leído
 * (bank-file.ts) y casado (bank-match.ts): qué carga de cada local del grupo,
 * qué guarda, qué sustituye y qué devuelve.
 */

const SALA_BAMBU = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const BAMBU_TERRAZA = '8d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a';
const GROUP = [SALA_BAMBU, BAMBU_TERRAZA];
const OWNER = { userId: 'c0ffee00-1111-4222-8333-444455556666', role: 'OWNER' as const, tenantId: SALA_BAMBU };
const STATEMENT_ID = 'a1b2c3d4-0000-4000-8000-0000000000aa';
const NOW = new Date('2026-10-16T10:00:00Z');
const PAID = ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const pid = (n: number): string => `5e1a7c00-${n}d2b-4c3d-8e4f-00000000000${n}`;
const [P1, P2, P3, P4, P5, P6] = [pid(1), pid(2), pid(3), pid(4), pid(5), pid(6)] as const;
const day = (d: string): Date => new Date(`${d}T00:00:00Z`);

/** Exportación de Canales (Redsys) de la noche del 13 al 14-oct-2026 (hora de Madrid, UTC+2). */
const REDSYS_CSV = [
  'Fecha;Hora;Tipo operación;Cód. pedido;Resultado operación y código;Importe;Moneda;Importe Euros',
  '13/10/2026;23:18:59;Autorización;2610MLbhyfNg;Autorizada 741936;60,00;EUR;60,00',
  '13/10/2026;23:40:02;Autorización;2610Zx81kQpa;Autorizada 553201;45,00;EUR;45,00',
  '14/10/2026;0:12:30;Autorización;2610Qq77RrSs;Autorizada 118822;30,00;EUR;30,00',
  '14/10/2026;1:05:10;Autorización;2610Nn00Zz99;Autorizada 440011;25,00;EUR;25,00',
  '14/10/2026;1:30:00;Devolución;2610MLbhyfNg;Autorizada 098692;20,00;EUR;20,00',
  '14/10/2026;2:00:00;Preautorización;2610Pp55Tt66;Autorizada 777000;100,00;EUR;100,00',
  '14/10/2026;2:10:00;Autorización;2610Dd44Ee55;Denegada 190;15,00;EUR;15,00',
].join('\r\n');

const sale = (id: string, tenantId: string, amountCents: number, tipCents: number, ref: string, at: string) => ({
  id,
  tenantId,
  amountCents,
  tipCents,
  authCode: null,
  authorizedAt: new Date(at),
  providerTxId: ref,
  attempts: [{ providerTxId: ref, amountCents: amountCents + tipCents }],
});

/** Lo apuntado en el grupo: 50 € + 10 € de propina (cuadra), 40 € (el banco dice 45), uno que el banco no tiene… */
const REDSYS_SALES = [
  sale(P1, SALA_BAMBU, 5000, 1000, '2610MLbhyfNg', '2026-10-13T21:19:00Z'),
  sale(P2, BAMBU_TERRAZA, 4000, 0, '2610Zx81kQpa', '2026-10-13T21:40:30Z'),
  sale(P3, SALA_BAMBU, 7000, 500, '2610Ww11Xx22', '2026-10-13T23:00:00Z'),
  // 23:30 del 12-oct: se carga por el margen del borde, pero no es de estos días.
  sale(P4, SALA_BAMBU, 9900, 0, '2610Kk00Ll11', '2026-10-12T21:30:00Z'),
];
const REDSYS_REFUND = {
  id: 'r-0001',
  paymentId: P1,
  tenantId: SALA_BAMBU,
  amountCents: 2000,
  bankRefundedAt: new Date('2026-10-13T23:30:00Z'),
  createdAt: new Date('2026-10-13T23:31:00Z'),
  payment: { providerTxId: '2610MLbhyfNg', attempts: [{ providerTxId: '2610MLbhyfNg' }] },
};
/** El banco cobró 2610Qq77RrSs y aquí el cobro caducó; 2610Nn00Zz99 consta pagado (fuera de los días) → no cuenta. */
const REDSYS_STRAYS = [
  { providerTxId: '2610Qq77RrSs', amountCents: 3000, payment: { id: P5, tenantId: BAMBU_TERRAZA, status: 'EXPIRED', amountCents: 3000, tipCents: 0 } },
  { providerTxId: '2610Nn00Zz99', amountCents: 2500, payment: { id: P6, tenantId: SALA_BAMBU, status: 'AUTHORIZED', amountCents: 2500, tipCents: 0 } },
];

function makeService(opts: { walletGroup?: string | null; older?: unknown[] } = {}) {
  const tx = {
    payment: { findMany: vi.fn().mockResolvedValue([]) },
    refund: { findMany: vi.fn().mockResolvedValue([]) },
    paymentAttempt: { findMany: vi.fn().mockResolvedValue([]) },
    terminal: { findMany: vi.fn().mockResolvedValue([]) },
    bankStatement: {
      findMany: vi.fn().mockResolvedValue(opts.older ?? []),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: STATEMENT_ID, ...data, supersededAt: null, createdAt: NOW })),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    bankStatementItem: {
      updateMany: vi.fn().mockResolvedValue({ count: 3 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const walletGroup = opts.walletGroup === undefined ? 'grupo-bambu' : opts.walletGroup;
  const prisma = {
    venue: {
      findUnique: vi.fn().mockResolvedValue({ walletGroup }),
      findMany: vi.fn(async ({ where }: { where: { walletGroup?: string } }) =>
        where.walletGroup
          ? GROUP.map((id) => ({ id }))
          : [{ id: SALA_BAMBU, name: 'Sala Bambú (Madrid)' }, { id: BAMBU_TERRAZA, name: 'Bambú Terraza' }],
      ),
    },
    acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  return { svc: new BankReconService(prisma as never, audit as never), prisma, tx, audit };
}

function redsysService(opts: Parameters<typeof makeService>[0] = {}) {
  const s = makeService(opts);
  s.tx.payment.findMany.mockResolvedValue(REDSYS_SALES);
  s.tx.refund.findMany.mockResolvedValue([REDSYS_REFUND]);
  s.tx.paymentAttempt.findMany.mockResolvedValue(REDSYS_STRAYS);
  return s;
}

const redsysInput = { source: 'REDSYS' as const, fileName: 'operaciones_canales_13-14oct.csv', content: Buffer.from(REDSYS_CSV, 'utf8') };

describe('importar el fichero de Redsys', () => {
  it('carga lo de todos los locales del grupo, con margen de 1 h en los bordes de los días', async () => {
    const { svc, prisma, tx } = redsysService();
    await svc.importStatement(OWNER, redsysInput, NOW);
    expect(prisma.venue.findUnique).toHaveBeenCalledWith({ where: { id: SALA_BAMBU }, select: { walletGroup: true } });
    // 13-oct a las 00:00 de Madrid = 22:00 UTC del 12, menos 1 h; 15-oct 00:00 = 22:00 UTC del 14, más 1 h.
    const range = { gte: new Date('2026-10-12T21:00:00Z'), lt: new Date('2026-10-14T23:00:00Z') };
    expect(tx.payment.findMany.mock.calls[0]![0].where).toEqual({
      tenantId: { in: GROUP },
      provider: 'REDSYS',
      status: { in: PAID },
      authorizedAt: range,
    });
    expect(tx.refund.findMany.mock.calls[0]![0].where).toMatchObject({
      tenantId: { in: GROUP },
      status: 'SUCCEEDED',
      OR: [{ bankRefundedAt: range }, { bankRefundedAt: null, createdAt: range }],
    });
    // Solo los pedidos cobrados en el banco que aquí no están pagados.
    expect(tx.paymentAttempt.findMany.mock.calls[0]![0].where).toEqual({
      provider: 'REDSYS',
      providerTxId: { in: ['2610Qq77RrSs', '2610Nn00Zz99'] },
      tenantId: { in: GROUP },
    });
    expect(tx.bankStatement.findMany.mock.calls[0]![0].where).toEqual({
      tenantId: { in: GROUP },
      source: 'REDSYS',
      periodFrom: { lte: day('2026-10-14') },
      periodTo: { gte: day('2026-10-13') },
      supersededAt: null,
    });
    expect(prisma.acrossVenues).toHaveBeenCalledTimes(2);
  });

  it('guarda cada línea con su estado y su local; totales del cuadre y resumen devuelto', async () => {
    const { svc, tx, audit } = redsysService();
    const out = await svc.importStatement(OWNER, redsysInput, NOW);

    const items = tx.bankStatementItem.createMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
    expect(items.map((i) => [i.status, i.tenantId, i.paymentId, i.bankAmountCents, i.oursAmountCents])).toEqual([
      ['MATCHED', SALA_BAMBU, P1, 6000, 6000],
      ['AMOUNT_MISMATCH', BAMBU_TERRAZA, P2, 4500, 4000],
      ['NOT_PAID_HERE', BAMBU_TERRAZA, P5, 3000, 3000],
      // Sin cobro de aquí: se atribuye al local que sube el fichero.
      ['NOT_IN_OXIOPAY', SALA_BAMBU, null, 2500, null],
      ['NOT_IN_BANK', SALA_BAMBU, P3, null, 7500],
      ['REFUND_MATCHED', SALA_BAMBU, P1, 2000, 2000],
    ]);
    expect(items.every((i) => i.statementId === STATEMENT_ID)).toBe(true);
    expect(items[0]).toMatchObject({ kind: 'SALE', line: 2, reference: '2610MLbhyfNg', authCode: '741936', occurredAt: new Date('2026-10-13T21:18:59Z') });
    expect(items[5]).toMatchObject({ kind: 'REFUND', refundId: 'r-0001', line: 6 });

    const sha = createHash('sha256').update(redsysInput.content).digest('hex');
    // 7 líneas (1 preautorización aparte); banco: 60 + 45 + 30 + 25 − 20; aquí: 60 + 40 + 75 − 20 (lo del 12-oct no cuenta).
    const counts = { rowsTotal: 7, skippedCount: 0, otherCount: 1, matchedCount: 2, problemCount: 4, bankTotalCents: 14_000, oursTotalCents: 15_500 };
    const head = { source: 'REDSYS', fileName: 'operaciones_canales_13-14oct.csv' };
    expect(tx.bankStatement.create.mock.calls[0]![0].data).toEqual({
      ...head,
      ...counts,
      tenantId: SALA_BAMBU,
      fileSha256: sha,
      periodFrom: day('2026-10-13'),
      periodTo: day('2026-10-14'),
      uploadedByUserId: OWNER.userId,
    });
    expect(out).toEqual({ ...head, ...counts, id: STATEMENT_ID, periodFrom: '2026-10-13', periodTo: '2026-10-14', superseded: false, createdAt: NOW.toISOString() });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'bank_statement.imported',
      tenantId: SALA_BAMBU,
      actorId: OWNER.userId,
      targetType: 'BankStatement',
      targetId: STATEMENT_ID,
      payload: { source: 'REDSYS', periodFrom: '2026-10-13', periodTo: '2026-10-14', rows: 7, skipped: 0, other: 1, problems: 4, fileSha256: sha },
    });
    // Sin cuadres anteriores de esos días: nada que sustituir.
    expect(tx.bankStatementItem.updateMany).not.toHaveBeenCalled();
  });

  it('subir otra vez los mismos días sustituye el cuadre anterior (no se cuenta dos veces)', async () => {
    const older = [
      { id: 'old-13-14', periodFrom: day('2026-10-13'), periodTo: day('2026-10-14') },
      { id: 'old-10-13', periodFrom: day('2026-10-10'), periodTo: day('2026-10-13') },
    ];
    const { svc, tx } = redsysService({ older });
    await svc.importStatement(OWNER, redsysInput, NOW);
    expect(tx.bankStatementItem.updateMany).toHaveBeenCalledWith({
      where: {
        statementId: { in: ['old-13-14', 'old-10-13'] },
        supersededAt: null,
        OR: [
          { occurredAt: { gte: new Date('2026-10-12T22:00:00Z'), lt: new Date('2026-10-14T22:00:00Z') } },
          { occurredAt: null, statementId: { in: ['old-13-14'] } },
        ],
      },
      data: { supersededAt: NOW },
    });
    // Solo el que este fichero cubre entero deja de contar; el del 10 al 13 sigue (sus días 10–12).
    expect(tx.bankStatement.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['old-13-14'] } }, data: { supersededAt: NOW } });
    expect(tx.bankStatementItem.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.bankStatement.create.mock.invocationCallOrder[0]!);
    expect(tx.bankStatement.create).toHaveBeenCalledTimes(1);
  });

  it('exportado hoy mismo: el cuadre acaba 10 min después de la última operación del fichero', async () => {
    const csv = [
      'Fecha;Hora;Tipo operación;Cód. pedido;Resultado operación y código;Importe Euros',
      '14/10/2026;17:30:00;Autorización;2610Hh11Jj22;Autorizada 120120;12,50',
    ].join('\n');
    const { svc, tx } = makeService({ older: [{ id: 'old', periodFrom: day('2026-10-14'), periodTo: day('2026-10-14') }] });
    // Sube el fichero a las 18:00 de Madrid; un cobro de las 17:50 aún no puede estar en él.
    tx.payment.findMany.mockResolvedValue([sale(P1, SALA_BAMBU, 4000, 0, '2610Tt99Uu88', '2026-10-14T15:50:00Z')]);
    await svc.importStatement(OWNER, { ...redsysInput, content: Buffer.from(csv, 'utf8') }, new Date('2026-10-14T16:00:00Z'));
    expect(tx.payment.findMany.mock.calls[0]![0].where.authorizedAt).toEqual({
      gte: new Date('2026-10-13T21:00:00Z'),
      lt: new Date('2026-10-14T16:40:00Z'),
    });
    expect(tx.bankStatementItem.updateMany.mock.calls[0]![0].where.OR[0]).toEqual({
      occurredAt: { gte: new Date('2026-10-13T22:00:00Z'), lt: new Date('2026-10-14T15:40:00Z') },
    });
    const items = tx.bankStatementItem.createMany.mock.calls[0]![0].data as Array<{ status: string }>;
    expect(items.map((i) => i.status)).toEqual(['NOT_IN_OXIOPAY']);
  });
});

describe('importar el fichero de Paytef (datáfonos)', () => {
  it('dos datáfonos con la operación 77: cada línea casa con el cobro de su datáfono (identificador o número de serie)', async () => {
    const { svc, tx } = makeService();
    tx.payment.findMany.mockResolvedValue([
      { id: P1, tenantId: SALA_BAMBU, amountCents: 5000, tipCents: 0, authCode: null, authorizedAt: new Date('2026-10-13T21:00:00Z'), posOperationNumber: '77', posTerminalId: 'terminal-a' },
      { id: P2, tenantId: BAMBU_TERRAZA, amountCents: 2000, tipCents: 0, authCode: null, authorizedAt: new Date('2026-10-13T21:00:00Z'), posOperationNumber: '77', posTerminalId: 'terminal-b' },
    ]);
    tx.terminal.findMany.mockResolvedValue([{ id: 'terminal-a', tenantId: SALA_BAMBU, externalId: 'A', deviceSerial: 'SERIAL-A' }, { id: 'terminal-b', tenantId: BAMBU_TERRAZA, externalId: 'B', deviceSerial: 'SERIAL-B' }]);
    const csv = 'Fecha;Hora;Terminal;Nº Operación;Tipo;Importe;Resultado\n13/10/2026;23:00:00;SERIAL-B;77;Venta;20,00;Aprobada\n13/10/2026;23:00:00;A;77;Venta;50,00;Aprobada';
    await svc.importStatement(OWNER, { source: 'PAYTEF', fileName: 'paytef.csv', content: Buffer.from(csv) }, NOW);
    const items = tx.bankStatementItem.createMany.mock.calls[0]![0].data;
    expect(items).toEqual([expect.objectContaining({ status: 'MATCHED', paymentId: P2 }), expect.objectContaining({ status: 'MATCHED', paymentId: P1 })]);
  });
  it('casa por número de operación y atribuye lo desconocido al local del datáfono', async () => {
    const csv = [
      'Fecha;Hora;Terminal;Nº Operación;Tipo;Importe;Autorización;Resultado',
      '13/10/2026;23:59:01;PTF-0041;000077;Venta;50,00;A1B2C3;Aprobada',
      '14/10/2026;00:40:00;TPV-TERRAZA-01;000099;Venta;35,00;Q1W2E3;Aprobada',
      '14/10/2026;01:10:00;PTF-0041;000123;Venta;18,00;K9L8M7;Aprobada',
      '14/10/2026;02:00:00;PTF-9999;000555;Venta;12,00;Z1Z2Z3;Aprobada',
    ].join('\n');
    const { svc, tx } = makeService();
    const ours = [{ id: P1, tenantId: SALA_BAMBU, amountCents: 4500, tipCents: 500, authCode: 'A1B2C3', authorizedAt: new Date('2026-10-13T21:59:30Z'), posOperationNumber: '000077' }];
    const stray = [{ id: P5, tenantId: BAMBU_TERRAZA, amountCents: 1500, tipCents: 300, posOperationNumber: '000123' }];
    tx.payment.findMany.mockImplementation(async ({ where }: { where: { posOperationNumber?: unknown } }) =>
      where.posOperationNumber ? stray : ours,
    );
    tx.terminal.findMany.mockResolvedValue([{ tenantId: BAMBU_TERRAZA, externalId: 'PTF-0042', deviceSerial: 'TPV-TERRAZA-01' }]);

    await svc.importStatement(OWNER, { source: 'PAYTEF', fileName: 'paytef.csv', content: Buffer.from(csv, 'utf8') }, NOW);

    const [salesWhere, strayWhere] = tx.payment.findMany.mock.calls.map((c) => c[0].where);
    expect(salesWhere).toMatchObject({ tenantId: { in: GROUP }, status: { in: PAID } });
    expect(salesWhere.OR).toEqual([{ posOperationNumber: { not: null } }, { provider: 'PAYTEF' }, { captureMethod: 'POS_EXTERNAL' }]);
    expect(strayWhere).toMatchObject({ tenantId: { in: GROUP }, status: { notIn: PAID } });
    expect(strayWhere.posOperationNumber.in).toEqual(expect.arrayContaining(['000099', '99', '000123', '123', '000555', '555']));
    expect(tx.terminal.findMany.mock.calls[1]![0].where).toEqual({
      tenantId: { in: GROUP },
      OR: [
        { externalId: { in: ['PTF-0041', 'TPV-TERRAZA-01', 'PTF-9999'] } },
        { deviceSerial: { in: ['PTF-0041', 'TPV-TERRAZA-01', 'PTF-9999'] } },
      ],
    });
    const items = tx.bankStatementItem.createMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
    expect(items.map((i) => [i.status, i.tenantId, i.paymentId, i.terminal])).toEqual([
      ['MATCHED', SALA_BAMBU, P1, 'PTF-0041'],
      ['NOT_PAID_HERE', BAMBU_TERRAZA, P5, 'PTF-0041'],
      ['NOT_IN_OXIOPAY', BAMBU_TERRAZA, null, 'TPV-TERRAZA-01'],
      ['NOT_IN_OXIOPAY', SALA_BAMBU, null, 'PTF-9999'],
    ]);
  });

  it('todo casado: la devolución casa por la operación del cobro; sin datáfono en el fichero mira si hay otro igual sin pagar', async () => {
    const csv = [
      'Fecha;Hora;Nº Operación;Tipo;Importe;Resultado',
      '13/10/2026;23:59:01;000077;Venta;50,00;Aprobada',
      '14/10/2026;00:20:00;000077;Devolución;-50,00;Aprobada',
    ].join('\n');
    const { svc, tx } = makeService();
    tx.payment.findMany.mockResolvedValue([
      { id: P1, tenantId: SALA_BAMBU, amountCents: 5000, tipCents: 0, authCode: null, authorizedAt: new Date('2026-10-13T21:59:10Z'), posOperationNumber: '000077' },
      // Cobro con datáfono sin número de operación (apuntado a mano) y sin línea en el fichero.
      { id: P2, tenantId: BAMBU_TERRAZA, amountCents: 2000, tipCents: 0, authCode: null, authorizedAt: new Date('2026-10-13T22:30:00Z'), posOperationNumber: null },
    ]);
    tx.refund.findMany.mockResolvedValue([{ id: 'r-77', paymentId: P1, tenantId: SALA_BAMBU, amountCents: 5000, bankRefundedAt: null, createdAt: new Date('2026-10-13T22:21:00Z'), payment: { posOperationNumber: '000077' } }]);
    tx.payment.findMany.mockResolvedValueOnce(await tx.payment.findMany()).mockResolvedValueOnce([]);
    tx.payment.findMany.mockClear();
    await svc.importStatement(OWNER, { source: 'PAYTEF', fileName: 'paytef.csv', content: Buffer.from(csv, 'utf8') }, NOW);
    // El fichero no dice el datáfono: un 77 sin pagar de otro datáfono lo haría ambiguo.
    expect(tx.payment.findMany).toHaveBeenCalledTimes(2);
    expect(tx.payment.findMany.mock.calls[1]![0].where).toMatchObject({ status: { notIn: PAID } });
    expect(tx.terminal.findMany).toHaveBeenCalledTimes(0);
    const items = tx.bankStatementItem.createMany.mock.calls[0]![0].data as Array<Record<string, unknown>>;
    expect(items.map((i) => [i.status, i.tenantId, i.paymentId, i.refundId, i.reference])).toEqual([
      ['MATCHED', SALA_BAMBU, P1, null, '000077'],
      ['NOT_IN_BANK', BAMBU_TERRAZA, P2, null, null],
      ['REFUND_MATCHED', SALA_BAMBU, P1, 'r-77', '000077'],
    ]);
    expect(tx.bankStatement.create.mock.calls[0]![0].data).toMatchObject({ bankTotalCents: 0, oursTotalCents: 2000, problemCount: 1 });
  });
});

describe('ficheros que no se aceptan', () => {
  it('solo el dueño: un encargado no llega ni a leer el fichero', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.importStatement({ ...OWNER, role: 'MANAGER' }, redsysInput, NOW)).rejects.toThrow(ForbiddenException);
    expect(prisma.acrossVenues).not.toHaveBeenCalled();
  });

  it('fichero vacío o ilegible → 400', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.importStatement(OWNER, { ...redsysInput, content: Buffer.alloc(0) }, NOW)).rejects.toThrow(BadRequestException);
    await expect(svc.importStatement(OWNER, { ...redsysInput, content: Buffer.from('a;b\n1;2') }, NOW)).rejects.toThrow(BadRequestException);
    expect(prisma.acrossVenues).not.toHaveBeenCalled();
  });

  it('sin fechas en el fichero hay que indicar los días; al revés o de más de 62 días → 400', async () => {
    const sinFechas = Buffer.from('Cód. pedido;Importe;Resultado\n2610MLbhyfNg;60,00;Autorizada 741936', 'utf8');
    const input = { ...redsysInput, content: sinFechas };
    const { svc, tx } = makeService();
    await expect(svc.importStatement(OWNER, input, NOW)).rejects.toThrow(/fechas/);
    await expect(svc.importStatement(OWNER, { ...input, periodFrom: '2026-10-14', periodTo: '2026-10-13' }, NOW)).rejects.toThrow(BadRequestException);
    await expect(svc.importStatement(OWNER, { ...input, periodFrom: '2026-08-13', periodTo: '2026-10-14' }, NOW)).rejects.toThrow(/62/);
    expect(tx.bankStatement.create).not.toHaveBeenCalled();
    await svc.importStatement(OWNER, { ...input, periodFrom: '2026-08-14', periodTo: '2026-10-14' }, NOW);
    expect(tx.bankStatement.create.mock.calls[0]![0].data).toMatchObject({ periodFrom: day('2026-08-14'), periodTo: day('2026-10-14') });
  });
});

describe('listado y detalle de cuadres', () => {
  const stored = {
    id: STATEMENT_ID,
    source: 'REDSYS',
    fileName: 'canales.csv',
    periodFrom: day('2026-10-13'),
    periodTo: day('2026-10-14'),
    rowsTotal: 7,
    skippedCount: 0,
    otherCount: 1,
    matchedCount: 2,
    problemCount: 4,
    bankTotalCents: 14_000,
    oursTotalCents: 15_500,
    // Sustituido por un fichero posterior de los mismos días.
    supersededAt: new Date('2026-10-15T09:00:00Z'),
    createdAt: NOW,
  };

  it('un local sin grupo solo ve los suyos: los 30 últimos, del más nuevo al más viejo', async () => {
    const { svc, tx, prisma } = makeService({ walletGroup: null });
    tx.bankStatement.findMany.mockResolvedValue([stored]);
    const list = await svc.list(OWNER);
    expect(tx.bankStatement.findMany).toHaveBeenCalledWith({ where: { tenantId: { in: [SALA_BAMBU] } }, orderBy: { createdAt: 'desc' }, take: 30 });
    expect(prisma.venue.findMany).not.toHaveBeenCalled();
    expect(list).toEqual([expect.objectContaining({ periodFrom: '2026-10-13', periodTo: '2026-10-14', superseded: true, problemCount: 4 })]);
    await expect(svc.list({ ...OWNER, role: 'WAITER' })).rejects.toThrow(ForbiddenException);
  });

  it('un cuadre de otro grupo no existe para este dueño (404) y no se leen sus líneas', async () => {
    const { svc, tx } = makeService();
    await expect(svc.detail(OWNER, 'f0f0f0f0-0000-4000-8000-00000000beef')).rejects.toThrow(NotFoundException);
    expect(tx.bankStatement.findFirst).toHaveBeenCalledWith({ where: { id: 'f0f0f0f0-0000-4000-8000-00000000beef', tenantId: { in: GROUP } } });
    expect(tx.bankStatementItem.findMany).not.toHaveBeenCalled();
    await expect(svc.detail({ ...OWNER, role: 'MANAGER' }, STATEMENT_ID)).rejects.toThrow(ForbiddenException);
  });

  it('detalle: lo que no cuadra primero, con el nombre de su local', async () => {
    const { svc, tx, prisma } = makeService();
    tx.bankStatement.findFirst.mockResolvedValue(stored);
    const item = (id: string, status: string, tenantId: string, occurredAt: Date | null) => ({
      id, status, tenantId, occurredAt, kind: 'SALE', line: null, bankAmountCents: 6000, oursAmountCents: 6000, reference: null, authCode: null, paymentId: null, supersededAt: null,
    });
    tx.bankStatementItem.findMany.mockResolvedValue([
      item('i1', 'MATCHED', SALA_BAMBU, new Date('2026-10-13T21:18:59Z')),
      item('i2', 'NOT_IN_BANK', BAMBU_TERRAZA, new Date('2026-10-13T21:40:30Z')),
      item('i3', 'REFUND_MATCHED', SALA_BAMBU, null),
      item('i4', 'NOT_IN_OXIOPAY', '99999999-0000-4000-8000-000000000000', null),
    ]);
    const out = await svc.detail(OWNER, STATEMENT_ID);
    expect(tx.bankStatementItem.findMany).toHaveBeenCalledWith({ where: { statementId: STATEMENT_ID }, orderBy: [{ occurredAt: 'asc' }, { line: 'asc' }] });
    expect(prisma.venue.findMany).toHaveBeenCalledWith({ where: { id: { in: GROUP } }, select: { id: true, name: true } });
    expect(out.items.map((i) => [i.id, i.venueName, i.occurredAt])).toEqual([
      ['i2', 'Bambú Terraza', '2026-10-13T21:40:30.000Z'],
      ['i4', null, null],
      ['i1', 'Sala Bambú (Madrid)', '2026-10-13T21:18:59.000Z'],
      ['i3', 'Sala Bambú (Madrid)', null],
    ]);
    expect(out.statement).toMatchObject({ id: STATEMENT_ID, superseded: true, createdAt: NOW.toISOString() });
  });
});

describe('variantes de una referencia del fichero', () => {
  it('con y sin ceros delante (Excel se los come); los pedidos de Redsys tienen 12 caracteres', () => {
    expect(referenceVariants(['0412ABCD1234'])).toEqual(['0412ABCD1234', '412ABCD1234']);
    expect(referenceVariants([' 000077 '])).toEqual(['000077', '77', '000000000077', '00000077', '0000000077']);
    expect(referenceVariants(['', '   ', '2610MLbhyfNg'])).toEqual(['2610MLbhyfNg']);
  });
});
