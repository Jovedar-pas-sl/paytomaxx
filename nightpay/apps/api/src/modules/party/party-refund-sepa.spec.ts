import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PartyRefundsController } from './party-refunds.controller';
import { PartyRefundsService } from './party-refunds.service';
import { refundSepaFileName, refundTransfer, refundTransfersSepa, type RefundSepaInput } from './party-refund-sepa';
import { NO_DEBTOR_IBAN_CODE, NO_TRANSFERS_CODE, SepaInputError } from './sepa';

/**
 * El fichero SEPA de las transferencias de «Lo que sobra»: una por petición
 * pendiente con IBAN, NbOfTxs y CtrlSum que cuadran, deudor = la cuenta del
 * local (sin ella, 409 NO_DEBTOR_IBAN), solo dueño y encargado, y al registro.
 */

const DEBTOR_IBAN = 'ES9121000418450200051332';
const IBAN_A = 'ES7921000813610123456789';
const IBAN_B = 'ES6000491500051234567892';
const NOW = new Date('2027-06-30T08:15:00Z');
const T = 'venue-1';
const ID_A = '0b6f2c1e-1111-4a8e-9c1d-aaaaaaaaaaaa';
const ID_B = '7c1d9e2f-2222-4b9f-8d2e-bbbbbbbbbbbb';
const ID_C = '9e3f1a4b-3333-4cae-9f3f-cccccccccccc';

function all(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => m[1] ?? '');
}

function input(extra: Partial<RefundSepaInput> = {}): RefundSepaInput {
  return {
    messageId: 'OXPD20270630081500ABC123',
    createdAt: NOW,
    executionDate: '2027-06-30',
    brand: 'OxioParty',
    debtor: { name: 'Comisión de Fiestas San Juan', iban: DEBTOR_IBAN },
    transfers: [
      { id: ID_A, amountCents: 500, iban: IBAN_A, pulsera: 'P-0412' },
      { id: ID_B, amountCents: 1_234, iban: IBAN_B, pulsera: null },
      { id: ID_C, amountCents: 99_999, iban: IBAN_A, pulsera: 'P-0007' },
    ],
    ...extra,
  };
}

describe('refundTransfersSepa (puro)', () => {
  it('NbOfTxs y CtrlSum cuadran con las transferencias (cabecera y orden)', () => {
    const file = refundTransfersSepa(input());
    expect(file).toMatchObject({ count: 3, totalCents: 101_733, messageId: 'OXPD20270630081500ABC123' });
    expect(all(file.xml, 'NbOfTxs')).toEqual(['3', '3']);
    expect(all(file.xml, 'CtrlSum')).toEqual(['1017.33', '1017.33']);
    expect(all(file.xml, 'InstdAmt')).toEqual(['5.00', '12.34', '999.99']);
    const sum = all(file.xml, 'InstdAmt').reduce((a, v) => a + Math.round(Number(v) * 100), 0);
    expect(sum).toBe(101_733);
  });

  it('una sola: NbOfTxs 1 y CtrlSum su importe', () => {
    const file = refundTransfersSepa(input({ transfers: [{ id: ID_A, amountCents: 1, iban: IBAN_A, pulsera: 'P-0412' }] }));
    expect(all(file.xml, 'NbOfTxs')).toEqual(['1', '1']);
    expect(all(file.xml, 'CtrlSum')).toEqual(['0.01', '0.01']);
  });

  it('deudor, la cuenta del local; acreedores, el IBAN de cada asistente', () => {
    const { xml } = refundTransfersSepa(input());
    expect(all(xml, 'IBAN')).toEqual([DEBTOR_IBAN, IBAN_A, IBAN_B, IBAN_A]);
    expect(all(xml, 'Nm')[0]).toBe('Comision de Fiestas San Juan');
    expect(all(xml, 'ReqdExctnDt')).toEqual(['2027-06-30']);
  });

  it('cada una con el id de la petición como referencia, sin datos del asistente más allá de la pulsera', () => {
    expect(refundTransfer({ id: ID_A, amountCents: 500, iban: IBAN_A, pulsera: 'P-0412' }, 'OxioParty')).toEqual({
      endToEndId: ID_A.replace(/-/g, ''),
      creditorName: 'Asistente OxioParty P-0412',
      creditorIban: IBAN_A,
      amountCents: 500,
      remittance: 'Devolución OxioParty P-0412',
    });
    const { xml } = refundTransfersSepa(input());
    expect(all(xml, 'EndToEndId')).toEqual([ID_A, ID_B, ID_C].map((id) => id.replace(/-/g, '')));
    expect(all(xml, 'Ustrd')).toEqual(['Devolucion OxioParty P-0412', `Devolucion OxioParty ${ID_B.slice(0, 8)}`, 'Devolucion OxioParty P-0007']);
    expect(all(xml, 'Nm')).toContain('Asistente OxioParty');
  });

  it('sin transferencias, no hay fichero', () => {
    expect(() => refundTransfersSepa(input({ transfers: [] }))).toThrow(SepaInputError);
  });

  it('el nombre del fichero', () => {
    expect(refundSepaFileName('2027-06-30')).toBe('transferencias-pendientes-2027-06-30.xml');
  });
});

// ─── El servicio con la base simulada ─────────────────────────────────

function pending(id: string, amountCents: number, iban: string, walletId = `w-${id.slice(0, 4)}`) {
  return {
    id,
    tenantId: T,
    walletId,
    amountCents,
    method: 'TRANSFER',
    iban,
    email: null,
    status: 'PENDING',
    createdAt: NOW,
    doneAt: null,
    doneById: null,
  };
}

function make(venue: { settlementIban: string | null; settlementHolder?: string | null } = { settlementIban: DEBTOR_IBAN }, previous: unknown[] = []) {
  const sql: string[] = [];
  const values: unknown[][] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = Prisma.sql(strings, ...(vals as Prisma.Sql[]));
      sql.push(q.sql);
      values.push(q.values);
      if (q.sql.includes('pg_advisory_xact_lock')) return [{ ok: 1 }];
      if (q.sql.includes('audit_events')) return previous;
      throw new Error(`consulta inesperada: ${q.sql}`);
    }),
    venue: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Fiestas de San Juan', settlementHolder: null, ...venue }) },
    partyRefundRequest: { findMany: vi.fn().mockResolvedValue([pending(ID_A, 500, IBAN_A, 'w-a'), pending(ID_B, 1_234, IBAN_B, 'w-b')]) },
    clientWallet: { findMany: vi.fn().mockResolvedValue([{ id: 'w-a', shortCode: 'K7Q4M2' }]) },
    walletCard: { findMany: vi.fn().mockResolvedValue([{ walletId: 'w-a', number: 412 }]) },
    user: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { log: vi.fn().mockResolvedValue(undefined), logInTx: vi.fn().mockResolvedValue(undefined) };
  const svc = new PartyRefundsService(prisma as never, audit as never);
  return { svc, tx, audit, sql, values };
}

const owner = { userId: 'owner-1', role: 'OWNER' as const, tenantId: T, email: 'org@fiesta.es' };

describe('PartyRefundsService.transfersSepa', () => {
  it('las transferencias pendientes con IBAN de este local; el fichero cuadra y queda en el registro', async () => {
    const { svc, tx, audit } = make({ settlementIban: DEBTOR_IBAN, settlementHolder: 'Comisión San Juan' });
    const file = await svc.transfersSepa(owner, NOW);
    expect(tx.partyRefundRequest.findMany.mock.calls[0]![0]).toMatchObject({
      where: { tenantId: T, status: 'PENDING', method: 'TRANSFER', iban: { not: null } },
    });
    expect(tx.venue.findUniqueOrThrow.mock.calls[0]![0]).toMatchObject({ where: { id: T } });
    expect(file).toMatchObject({ count: 2, totalCents: 1_734 });
    expect(all(file.xml, 'NbOfTxs')).toEqual(['2', '2']);
    expect(all(file.xml, 'CtrlSum')).toEqual(['17.34', '17.34']);
    expect(all(file.xml, 'IBAN')).toEqual([DEBTOR_IBAN, IBAN_A, IBAN_B]);
    expect(all(file.xml, 'Nm')[0]).toBe('Comision San Juan');
    expect(file.xml).toContain('Devolucion OxioParty P-0412');
    expect(file.messageId).toMatch(/^OXPD20270630081500[0-9A-F]{6}$/);
    // El registro, en la misma transacción que la comprobación, con las peticiones que lleva.
    expect(audit.logInTx).toHaveBeenCalledTimes(1);
    expect(audit.logInTx.mock.calls[0]![1]).toMatchObject({
      action: 'party.refunds.sepa_exported',
      tenantId: T,
      actorId: 'owner-1',
      actorEmail: 'org@fiesta.es',
      targetType: 'Venue',
      targetId: T,
      payload: { messageId: file.messageId, transfers: 2, totalCents: 1_734, ids: [ID_A, ID_B] },
    });
    // En el registro no van los IBAN.
    expect(JSON.stringify(audit.logInTx.mock.calls[0]![1])).not.toContain(IBAN_A);
  });

  it('con alguna ya en un fichero descargado antes: 409 ALREADY_EXPORTED con cuándo y quién; con again, otra vez', async () => {
    const at = new Date('2027-06-29T19:30:00Z');
    const { svc, audit, sql, values } = make(undefined, [{ at, actorId: null, actorEmail: 'paco@fiesta.es' }]);
    const err = await svc.transfersSepa(owner, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'ALREADY_EXPORTED', exportedAt: at.toISOString(), exportedBy: 'paco' });
    expect(audit.logInTx).not.toHaveBeenCalled();
    // Se busca por las peticiones de este fichero, en el registro de este local.
    const i = sql.findIndex((x) => x.includes('audit_events'));
    expect(values[i]).toEqual([T, 'party.refunds.sepa_exported', [ID_A, ID_B]]);
    const again = await svc.transfersSepa(owner, NOW, { again: true });
    expect(again.count).toBe(2);
    expect(audit.logInTx.mock.calls[0]![1]).toMatchObject({ payload: { again: true, previousAt: at.toISOString(), ids: [ID_A, ID_B] } });
  });

  it('sin la cuenta del local: 409 NO_DEBTOR_IBAN, como en el cierre, y sin registro', async () => {
    const { svc, audit } = make({ settlementIban: null });
    const err = await svc.transfersSepa(owner, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: NO_DEBTOR_IBAN_CODE });
    expect(audit.logInTx).not.toHaveBeenCalled();
  });

  it('ninguna pendiente: 409 NO_TRANSFERS y sin registro', async () => {
    const { svc, tx, audit } = make();
    tx.partyRefundRequest.findMany.mockResolvedValue([]);
    const err = await svc.transfersSepa(owner, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: NO_TRANSFERS_CODE });
    expect(audit.logInTx).not.toHaveBeenCalled();
  });
});

describe('GET /v1/admin/party/refunds/transferencias.sepa', () => {
  it('solo el dueño y el encargado (como el SEPA del cierre)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, PartyRefundsController.prototype.transfersSepa)).toEqual(['OWNER', 'MANAGER']);
  });
});
