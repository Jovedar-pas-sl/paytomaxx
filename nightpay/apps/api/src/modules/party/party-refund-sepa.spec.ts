import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
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

function make(venue: { settlementIban: string | null; settlementHolder?: string | null } = { settlementIban: DEBTOR_IBAN }) {
  const tx = {
    venue: { findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Fiestas de San Juan', settlementHolder: null, ...venue }) },
    partyRefundRequest: { findMany: vi.fn().mockResolvedValue([pending(ID_A, 500, IBAN_A, 'w-a'), pending(ID_B, 1_234, IBAN_B, 'w-b')]) },
    clientWallet: { findMany: vi.fn().mockResolvedValue([{ id: 'w-a', shortCode: 'K7Q4M2' }]) },
    walletCard: { findMany: vi.fn().mockResolvedValue([{ walletId: 'w-a', number: 412 }]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new PartyRefundsService(prisma as never, audit as never);
  return { svc, tx, audit };
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
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0]![0]).toMatchObject({
      action: 'party.refunds.sepa_exported',
      tenantId: T,
      actorId: 'owner-1',
      actorEmail: 'org@fiesta.es',
      targetType: 'Venue',
      targetId: T,
      payload: { messageId: file.messageId, transfers: 2, totalCents: 1_734 },
    });
    // En el registro no van los IBAN.
    expect(JSON.stringify(audit.log.mock.calls[0]![0])).not.toContain(IBAN_A);
  });

  it('sin la cuenta del local: 409 NO_DEBTOR_IBAN, como en el cierre, y sin registro', async () => {
    const { svc, audit } = make({ settlementIban: null });
    const err = await svc.transfersSepa(owner, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: NO_DEBTOR_IBAN_CODE });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('ninguna pendiente: 409 NO_TRANSFERS y sin registro', async () => {
    const { svc, tx, audit } = make();
    tx.partyRefundRequest.findMany.mockResolvedValue([]);
    const err = await svc.transfersSepa(owner, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: NO_TRANSFERS_CODE });
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('GET /v1/admin/party/refunds/transferencias.sepa', () => {
  it('solo el dueño y el encargado (como el SEPA del cierre)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, PartyRefundsController.prototype.transfersSepa)).toEqual(['OWNER', 'MANAGER']);
  });
});
