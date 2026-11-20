// Integración (Postgres real): OxioParty, pulseras y «Lo que sobra» (migración
// 20261120300100_oxioparty_devoluciones). Con EDITION=party: pedir la devolución bloquea el
// saldo de verdad (la pulsera ya no paga), a la tarjeta solo lo cargado con tarjeta, la
// transferencia con su IBAN, donar al momento (y apagado, no), «Hecha» saca el dinero del
// saldo, anular lo desbloquea, el plazo, los totales, el CSV y el fichero SEPA de las
// transferencias. Pulseras: preparar en lote,
// recuento, hoja con QR y pasar el saldo de una perdida a otra. El estado del cobro del saldo
// con la pulsera y lo que le queda. Las reglas de la base y repetir la migración. np_app y FORCE RLS.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { PartyRefundsService } from '../../src/modules/party/party-refunds.service';
import { PulserasService } from '../../src/modules/party/pulseras.service';
import { PARTY_REFUND_BLOCK_REASON } from '../../src/modules/party/party-refund-rules';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const charges = new WalletChargesService(prisma as never, audit, { get: () => ({}) } as never, {} as never);
const mail = { send: vi.fn(async () => ({ ok: true, delivered: false })) };
const refunds = new PartyRefundsService(prisma, audit, mail as never);
const config = { get: (k: string) => (k === 'OPERATOR_BASE_URL' ? 'https://operator.fiesta.test' : undefined) };
const pulseras = new PulserasService(prisma, audit, config as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-party-dev' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
const IBAN = 'ES9121000418450200051332';
const HOLDER = 'Ana Pérez Núñez';
let V: string, OTHER: string, owner: string, toni: string;
let n = 0;
const actor = () => ({ userId: owner, role: 'OWNER' as const, tenantId: V, email: `org-${r}@x.es` });
const waiter = () => ({ userId: toni, role: 'WAITER' as const, tenantId: V });

function code6(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/** Un saldo con su pulsera: `cashCents` de lo que tiene entró en efectivo (el resto, con tarjeta). */
async function wallet(balanceCents: number, cashCents = 0): Promise<{ id: string; card: string; uid: string; number: number }> {
  n += 1;
  const card = randomBytes(16).toString('base64url');
  const uid = randomBytes(7).toString('hex').toUpperCase();
  return sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: V, balanceCents, qrToken: `pdev-${r}-${n}-abcdefgh`, shortCode: code6(), walletGroup: `gpdev-${r}` },
    });
    if (cashCents > 0) {
      await tx.walletCashTopUp.create({ data: { tenantId: V, walletId: w.id, amountCents: cashCents, takenByUserId: owner, idempotencyKey: `pdev-${r}-${n}` } });
    }
    const c = await tx.walletCard.create({ data: { token: card, uid, walletId: w.id, status: 'ISSUED', venueId: V, linkedAt: new Date() } });
    return { id: w.id, card, uid, number: c.number };
  });
}

const walletRow = (id: string) => sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id } }));

/** Un cobro con QR de la barra pagado acercando la pulsera. */
async function payWithBand(w: { card: string; uid: string }, amountCents: number) {
  const qr = await inVenue(V, () => charges.createQrCharge(waiter(), { amountCents, category: 'VENUE_BAR' } as never));
  return inVenue(V, () => charges.payQrChargeWithCard(waiter(), qr.id, { card: w.card, uid: w.uid }));
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({
      data: { name: 'Fiestas de San Juan', slug: `pdev-${r}`, walletGroup: `gpdev-${r}`, refundDeadline: new Date('2099-06-30T00:00:00Z'), allowDonation: true },
    })).id;
    OTHER = (await tx.venue.create({ data: { name: 'Otra fiesta', slug: `pdev-otra-${r}` } })).id;
    owner = (await tx.user.create({ data: { tenantId: V, email: `org-${r}@x.es`, passwordHash: 'x', role: 'OWNER', displayName: 'Lola' } })).id;
    toni = (await tx.user.create({ data: { tenantId: V, email: `toni-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
    terminal = (await tx.terminal.create({ data: { tenantId: V, externalId: `PDEV-${r}`, label: 'Taquilla', zone: 'BARRA' } })).id;
  });
});

let terminal: string;

/** Una recarga con tarjeta del saldo en ese estado (CREATED, AUTHORIZING…: sin respuesta del banco aún). */
async function topUp(walletId: string, status: 'CREATED' | 'AWAITING_CAPTURE' | 'AUTHORIZING' | 'AUTHORIZED' | 'FAILED' | 'EXPIRED', amountCents = 2000) {
  return sys((tx) =>
    tx.payment.create({
      data: {
        tenantId: V,
        terminalId: terminal,
        idempotencyKey: `pdev-top-${randomBytes(8).toString('hex')}`,
        amountCents,
        availableAmountCents: amountCents,
        status,
        qrToken: `pdev-qr-${randomBytes(8).toString('hex')}`,
        qrExpiresAt: new Date(Date.now() + 300_000),
        walletId,
        captureMethod: 'WALLET_TOPUP',
      },
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('«Lo que sobra» con EDITION=party', () => {
  it('pedirlo bloquea el saldo: la pulsera ya no paga; a la tarjeta solo lo de la tarjeta; el resto por transferencia', async () => {
    vi.stubEnv('EDITION', 'party');
    // 13 € en el saldo: 5 € entraron en efectivo, 8 € con tarjeta.
    const w = await wallet(1300, 500);
    const before = await refunds.view(w.id);
    expect(before).toMatchObject({ open: true, deadline: '2099-06-30', allowDonation: true, locked: false, faceId: false, available: { CARD: 800, TRANSFER: 500, DONATE: 1300 } });

    const asked = await refunds.ask(w.id, { method: 'CARD', email: 'ana@correo.es', expectedAmountCents: 800 });
    expect(asked).toMatchObject({ locked: true, available: { CARD: 0, TRANSFER: 500, DONATE: 500 } });
    expect(asked.requests).toEqual([expect.objectContaining({ method: 'CARD', amountCents: 800, status: 'PENDING', ibanHint: null })]);
    expect(await walletRow(w.id)).toMatchObject({ balanceCents: 1300, status: 'ACTIVE', blockedReason: PARTY_REFUND_BLOCK_REASON });
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ana@correo.es' }));

    // Bloqueado de verdad: la pulsera no paga (ni sin PIN).
    await expect(payWithBand(w, 300)).rejects.toMatchObject({ status: 409 });
    expect((await walletRow(w.id)).balanceCents).toBe(1300);

    // La tarjeta ya está pedida; la transferencia, con su IBAN, sí.
    await expect(refunds.ask(w.id, { method: 'CARD' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REFUND_METHOD_UNAVAILABLE' }) });
    const both = await refunds.ask(w.id, { method: 'TRANSFER', iban: IBAN, holderName: HOLDER });
    expect(both).toMatchObject({ locked: true, available: { CARD: 0, TRANSFER: 0, DONATE: 0 } });
    expect(both.requests.find((q) => q.method === 'TRANSFER')).toMatchObject({ amountCents: 500, ibanHint: 'ES91 •••• •••• 1332' });

    // El panel: «Hecha» la de la tarjeta (sale del saldo; sigue bloqueado por la otra).
    const list = await refunds.list(V, { status: 'PENDING' });
    const card = list.rows.find((x) => x.method === 'CARD')!;
    expect(card).toMatchObject({ amountCents: 800, pulsera: `P-${String(w.number).padStart(4, '0')}`, email: 'ana@correo.es' });
    const done = await refunds.markDone(actor(), card.id);
    // Hecha: sin el correo (el justificante ya salió con él).
    expect(done).toMatchObject({ status: 'DONE', doneByName: 'Lola', email: null, ibanHint: null, holderName: null });
    expect(mail.send).toHaveBeenLastCalledWith(expect.objectContaining({ to: 'ana@correo.es', subject: expect.stringMatching(/Hecho/) }));
    expect(await walletRow(w.id)).toMatchObject({ balanceCents: 500, status: 'ACTIVE', blockedReason: PARTY_REFUND_BLOCK_REASON });
    await expect(refunds.markDone(actor(), card.id)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REFUND_NOT_PENDING' }) });

    // El CSV de las transferencias pendientes lleva el titular y el IBAN entero.
    const csv = await refunds.transfersCsv(V);
    expect(csv).toContain(IBAN);
    expect(csv).toContain(HOLDER);
    expect(csv).toContain('5,00');

    // Anular la transferencia: no sale nada y el saldo vuelve a pagar.
    const transfer = (await refunds.list(V, { status: 'PENDING', method: 'TRANSFER' })).rows.find((x) => x.method === 'TRANSFER')!;
    await refunds.cancel(actor(), transfer.id);
    expect(await walletRow(w.id)).toMatchObject({ balanceCents: 500, blockedAt: null, blockedReason: null });
    await expect(payWithBand(w, 200)).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect((await walletRow(w.id)).balanceCents).toBe(300);
  });

  it('a la tarjeta, lo cargado en efectivo no; donar, al momento y el saldo se cierra', async () => {
    vi.stubEnv('EDITION', 'party');
    const w = await wallet(700, 700);
    await expect(refunds.ask(w.id, { method: 'CARD' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REFUND_METHOD_UNAVAILABLE' }) });
    // Lo que vio el asistente ya no es: 409 sin pedir nada.
    await expect(refunds.ask(w.id, { method: 'DONATE', expectedAmountCents: 900 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'REFUND_AMOUNT_CHANGED' }),
    });
    const v = await refunds.ask(w.id, { method: 'DONATE' });
    expect(v).toMatchObject({ locked: false, balanceCents: 0, requests: [expect.objectContaining({ method: 'DONATE', status: 'DONE', amountCents: 700 })] });
    expect(await walletRow(w.id)).toMatchObject({ balanceCents: 0, status: 'REFUNDED', blockedAt: null });
    const totals = (await refunds.list(V)).totals;
    expect(totals.donatedCents).toBeGreaterThanOrEqual(700);
  });

  it('con donar apagado, no; pasado el plazo, nada; un saldo bloqueado por el super-admin, tampoco', async () => {
    vi.stubEnv('EDITION', 'party');
    const w = await wallet(400);
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { allowDonation: false } }));
    try {
      await expect(refunds.ask(w.id, { method: 'DONATE' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'DONATION_OFF' }) });
      expect((await refunds.view(w.id)).available.DONATE).toBe(0);
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: V }, data: { allowDonation: true } }));
    }
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { refundDeadline: new Date('2020-01-31T00:00:00Z') } }));
    try {
      await expect(refunds.ask(w.id, { method: 'CARD' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REFUND_CLOSED' }) });
      expect(await refunds.view(w.id)).toMatchObject({ open: false, deadline: '2020-01-31' });
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: V }, data: { refundDeadline: new Date('2099-06-30T00:00:00Z') } }));
    }
    await sys((tx) => tx.clientWallet.update({ where: { id: w.id }, data: { blockedAt: new Date(), blockedReason: 'Revisión' } }));
    await expect(refunds.ask(w.id, { method: 'CARD' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'WALLET_BLOCKED' }) });
  });

  it('dos peticiones a la vez por la misma vía: una sola pendiente', async () => {
    vi.stubEnv('EDITION', 'party');
    const w = await wallet(1000);
    const res = await Promise.allSettled([refunds.ask(w.id, { method: 'CARD' }), refunds.ask(w.id, { method: 'CARD' })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await sys((tx) => tx.partyRefundRequest.count({ where: { walletId: w.id, status: 'PENDING' } }))).toBe(1);
  });

  it('con una recarga a medias (CREATED, AWAITING_CAPTURE o AUTHORIZING), 409 TOPUP_IN_PROGRESS sin pedir ni bloquear nada', async () => {
    vi.stubEnv('EDITION', 'party');
    const w = await wallet(1500);
    // Una ya sumada o que el banco no aprobó no cuenta.
    await topUp(w.id, 'AUTHORIZED');
    await topUp(w.id, 'FAILED');
    await topUp(w.id, 'EXPIRED');
    for (const status of ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING'] as const) {
      const open = await topUp(w.id, status);
      for (const method of ['CARD', 'DONATE'] as const) {
        await expect(refunds.ask(w.id, { method })).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'TOPUP_IN_PROGRESS' }) });
      }
      expect(await sys((tx) => tx.partyRefundRequest.count({ where: { walletId: w.id } }))).toBe(0);
      expect(await walletRow(w.id)).toMatchObject({ balanceCents: 1500, blockedAt: null });
      // El banco dice que no: ya se puede pedir.
      await sys((tx) => tx.payment.update({ where: { id: open.id }, data: { status: 'FAILED' } }));
    }
    await expect(refunds.ask(w.id, { method: 'CARD', expectedAmountCents: 1500 })).resolves.toMatchObject({ locked: true });
  });

  it('datos del asistente: al hacerla o anularla se borran el IBAN, el titular y el correo; el registro no los lleva; donar no guarda el correo', async () => {
    vi.stubEnv('EDITION', 'party');
    const stored = (walletId: string) =>
      sys((tx) => tx.partyRefundRequest.findMany({ where: { walletId }, select: { id: true, status: true, iban: true, holderName: true, email: true } }));
    const logged = (id: string) => sys((tx) => tx.auditEvent.findMany({ where: { targetType: 'PartyRefundRequest', targetId: id } }));

    // Pedida: lo justo para hacerla (IBAN, titular y, si quiso, el correo).
    const a = await wallet(900, 900);
    await refunds.ask(a.id, { method: 'TRANSFER', iban: IBAN, holderName: HOLDER, email: 'ana@correo.es' });
    const [pending] = await stored(a.id);
    expect(pending).toMatchObject({ status: 'PENDING', iban: IBAN, holderName: HOLDER, email: 'ana@correo.es' });
    // Hecha: se borra todo; el justificante sale igual, con el IBAN tapado.
    mail.send.mockClear();
    await refunds.markDone(actor(), pending!.id);
    expect(await stored(a.id)).toEqual([{ id: pending!.id, status: 'DONE', iban: null, holderName: null, email: null }]);
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ana@correo.es', text: expect.stringContaining('ES91 •••• •••• 1332') }));
    // Anulada: igual.
    const b = await wallet(600, 600);
    await refunds.ask(b.id, { method: 'TRANSFER', iban: IBAN, holderName: 'Jordi Puig i Ferrer', email: 'jordi@correo.es' });
    const [other] = await stored(b.id);
    await refunds.cancel(actor(), other!.id);
    expect(await stored(b.id)).toEqual([{ id: other!.id, status: 'CANCELED', iban: null, holderName: null, email: null }]);
    // En el registro (que no se puede borrar), ni el IBAN, ni el titular, ni el correo.
    for (const ev of [...(await logged(pending!.id)), ...(await logged(other!.id))]) {
      const text = JSON.stringify(ev.payload);
      for (const secret of [IBAN, '1332', HOLDER, 'Pérez', 'Jordi', 'correo.es']) expect(text).not.toContain(secret);
    }
    expect((await logged(pending!.id)).map((e) => e.action).sort()).toEqual(['party.refund.done', 'party.refund.requested']);
    // Donar se hace al momento: su correo no se guarda, pero el justificante le llega.
    mail.send.mockClear();
    const c = await wallet(300);
    await refunds.ask(c.id, { method: 'DONATE', email: 'lu@correo.es' });
    expect(await stored(c.id)).toEqual([expect.objectContaining({ status: 'DONE', email: null, iban: null, holderName: null })]);
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'lu@correo.es' }));
  });

  it('el panel de un local no ve las de otro', async () => {
    const other = await refunds.list(OTHER);
    expect(other.rows).toEqual([]);
    expect(other.totals.pending.CARD.count).toBe(0);
  });
});

describe('el fichero SEPA de las transferencias pendientes', () => {
  const DEBTOR = 'ES7921000813610123456789';
  const IBAN_2 = 'ES6000491500051234567892';
  const tags = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);
  const e2e = (id: string) => id.replace(/-/g, '');

  it('sin la cuenta del local, 409 NO_DEBTOR_IBAN; con ella, solo las transferencias pendientes con IBAN (NbOfTxs y CtrlSum) y queda en el registro', async () => {
    vi.stubEnv('EDITION', 'party');
    const a = await wallet(700, 700);
    const b = await wallet(1250, 1250);
    const c = await wallet(900);
    const d = await wallet(300, 300);
    await refunds.ask(a.id, { method: 'TRANSFER', iban: IBAN, holderName: HOLDER });
    await refunds.ask(b.id, { method: 'TRANSFER', iban: IBAN_2, holderName: 'Jordi Puig i Ferrer' });
    await refunds.ask(c.id, { method: 'CARD' });
    await refunds.ask(d.id, { method: 'TRANSFER', iban: IBAN, holderName: HOLDER });
    const ids = await sys(async (tx) =>
      Object.fromEntries(
        (await tx.partyRefundRequest.findMany({ where: { walletId: { in: [a.id, b.id, c.id, d.id] } }, select: { id: true, walletId: true } })).map((x) => [
          x.walletId,
          x.id,
        ]),
      ),
    );
    // La de d, ya hecha: no va.
    await refunds.markDone(actor(), ids[d.id]!);

    await expect(refunds.transfersSepa(actor())).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'NO_DEBTOR_IBAN' }) });

    await sys((tx) => tx.venue.update({ where: { id: V }, data: { settlementIban: DEBTOR, settlementHolder: 'Comisión de Fiestas' } }));
    try {
      const expected = await sys((tx) =>
        tx.partyRefundRequest.findMany({ where: { tenantId: V, status: 'PENDING', method: 'TRANSFER', iban: { not: null } }, select: { id: true, amountCents: true } }),
      );
      const total = expected.reduce((acc, x) => acc + x.amountCents, 0);
      const file = await inVenue(V, () => refunds.transfersSepa(actor()));
      expect(file.count).toBe(expected.length);
      expect(file.count).toBeGreaterThanOrEqual(2);
      expect(file.totalCents).toBe(total);
      expect(tags(file.xml, 'NbOfTxs')).toEqual([String(expected.length), String(expected.length)]);
      const ctrl = `${Math.floor(total / 100)}.${String(total % 100).padStart(2, '0')}`;
      expect(tags(file.xml, 'CtrlSum')).toEqual([ctrl, ctrl]);
      expect(tags(file.xml, 'IBAN')[0]).toBe(DEBTOR);
      expect(tags(file.xml, 'EndToEndId').sort()).toEqual(expected.map((x) => e2e(x.id)).sort());
      expect(tags(file.xml, 'EndToEndId')).toEqual(expect.arrayContaining([e2e(ids[a.id]!), e2e(ids[b.id]!)]));
      expect(tags(file.xml, 'EndToEndId')).not.toContain(e2e(ids[c.id]!));
      expect(tags(file.xml, 'EndToEndId')).not.toContain(e2e(ids[d.id]!));
      expect(file.xml).toContain(IBAN_2);
      // A nombre del titular de cada una (el banco compara nombre e IBAN).
      expect(tags(file.xml, 'Nm')).toEqual(expect.arrayContaining(['Ana Perez Nunez', 'Jordi Puig i Ferrer']));
      // No marca nada: siguen pendientes.
      expect(await sys((tx) => tx.partyRefundRequest.count({ where: { id: { in: [ids[a.id]!, ids[b.id]!] }, status: 'PENDING' } }))).toBe(2);
      const logged = await sys((tx) => tx.auditEvent.findFirst({ where: { tenantId: V, action: 'party.refunds.sepa_exported' }, orderBy: { occurredAt: 'desc' } }));
      expect(logged).toMatchObject({ actorId: owner, payload: expect.objectContaining({ transfers: expected.length, totalCents: total }) });
      expect((logged!.payload as { ids: string[] }).ids.sort()).toEqual(expected.map((x) => x.id).sort());
      // Otra vez con las mismas pendientes (no marca «Hecha»): 409 ALREADY_EXPORTED con cuándo y quién.
      const twice = await inVenue(V, () => refunds.transfersSepa(actor())).catch((e: unknown) => e);
      expect(twice).toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'ALREADY_EXPORTED', exportedAt: logged!.occurredAt.toISOString(), exportedBy: 'Lola' }),
      });
      // Una nueva junto a las de antes también avisa (las de antes irían dos veces).
      const e = await wallet(400, 400);
      await refunds.ask(e.id, { method: 'TRANSFER', iban: IBAN, holderName: HOLDER });
      await expect(inVenue(V, () => refunds.transfersSepa(actor()))).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ALREADY_EXPORTED' }) });
      // A propósito (el panel lo confirma): sale con todas, y queda en el registro como repetido.
      const again = await inVenue(V, () => refunds.transfersSepa(actor(), new Date(), { again: true }));
      expect(again.count).toBe(expected.length + 1);
      const last = await sys((tx) => tx.auditEvent.findFirstOrThrow({ where: { tenantId: V, action: 'party.refunds.sepa_exported' }, orderBy: { id: 'desc' } }));
      expect(last.payload).toMatchObject({ again: true, previousAt: logged!.occurredAt.toISOString() });
      // Otro local: sin su cuenta, no hay fichero (y nunca lleva las de este).
      await expect(refunds.transfersSepa({ ...actor(), tenantId: OTHER })).rejects.toMatchObject({ status: 409 });
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: V }, data: { settlementIban: null, settlementHolder: null } }));
    }
  });
});

describe('el estado del cobro del saldo (app del personal)', () => {
  it('con party: la pulsera y lo que le queda, también pagado sin acercarla; con club, nada nuevo', async () => {
    vi.stubEnv('EDITION', 'party');
    const w = await wallet(2000);
    const label = `P-${String(w.number).padStart(4, '0')}`;
    const paid = await payWithBand(w, 500);
    expect(paid).toMatchObject({ status: 'ACCEPTED', pulsera: label, balanceLeftCents: 1500, newBalanceCents: 1500 });
    const qr = await inVenue(V, () => charges.createQrCharge(waiter(), { amountCents: 300, category: 'VENUE_BAR' } as never));
    await inVenue(V, () => charges.payQrChargeWithCard(waiter(), qr.id, { card: w.card, uid: w.uid }));
    // Lo que consulta la app mientras espera (sin la pulsera en la mano): la que tiene dada.
    expect(await inVenue(V, () => charges.getRequest(waiter(), qr.id))).toMatchObject({ pulsera: label, balanceLeftCents: 1200 });
    vi.stubEnv('EDITION', 'club');
    const club = await inVenue(V, () => charges.getRequest(waiter(), qr.id));
    expect(club).not.toHaveProperty('pulsera');
    expect(club).not.toHaveProperty('balanceLeftCents');
    expect(club.newBalanceCents).toBe(1200);
  });
});

describe('pulseras en lote', () => {
  it('preparar N: números seguidos, ya en el stock; recuento, buscador y hoja con su QR', async () => {
    vi.stubEnv('EDITION', 'party');
    const made = await pulseras.prepare(actor(), 5);
    expect(made.count).toBe(5);
    expect(made.last - made.first).toBe(4);
    const view = await pulseras.view(V);
    expect(view.counts.STOCK).toBeGreaterThanOrEqual(5);
    expect(view.counts.total).toBe(Object.entries(view.counts).filter(([k]) => k !== 'total').reduce((s, [, v]) => s + v, 0));
    const found = await pulseras.view(V, { q: made.firstLabel });
    expect(found.rows.map((x) => x.label)).toEqual([made.firstLabel]);
    expect(found.rows[0]).toMatchObject({ status: 'STOCK', walletCode: null, hasUid: false });
    const html = await pulseras.sheet(V, { from: made.first, to: made.last });
    expect(html).toContain(made.firstLabel);
    expect(html).toContain(made.lastLabel);
    expect(html.match(/<svg/g)?.length).toBe(5);
    // Otro local no imprime las de este.
    await expect(pulseras.sheet(OTHER, { from: made.first, to: made.last })).rejects.toMatchObject({ status: 404 });
  });

  it('la hoja solo lleva las sin entregar: la que ya tiene saldo no sale (su QR es el enlace de un asistente)', async () => {
    vi.stubEnv('EDITION', 'party');
    const made = await pulseras.prepare(actor(), 4);
    const [given, returned] = [made.first + 1, made.first + 2];
    await sys(async (tx) => {
      const w = await tx.clientWallet.create({
        data: { tenantId: V, balanceCents: 1500, qrToken: `pdev-hoja-${r}-abcdefgh`, shortCode: code6(), walletGroup: `gpdev-${r}` },
      });
      await tx.walletCard.update({ where: { number: given }, data: { walletId: w.id, status: 'ISSUED', linkedAt: new Date() } });
      await tx.walletCard.update({ where: { number: returned }, data: { status: 'RETURNED' } });
    });
    const html = await pulseras.sheet(V, { from: made.first, to: made.last });
    const label = (x: number) => `P-${String(x).padStart(4, '0')}`;
    expect(html.match(/<svg/g)?.length).toBe(3);
    expect(html).toContain(label(made.first));
    expect(html).toContain(label(returned));
    expect(html).toContain(label(made.last));
    expect(html).not.toContain(label(given));
    // Solo la entregada en el rango: nada que imprimir.
    await expect(pulseras.sheet(V, { from: given, to: given })).rejects.toMatchObject({ status: 404 });
  });

  it('perdida: se bloquea y su saldo pasa a otra del stock (la nueva paga, la vieja no)', async () => {
    vi.stubEnv('EDITION', 'party');
    const w = await wallet(1000);
    const old = (await pulseras.view(V, { q: String(w.number) })).rows[0]!;
    const fresh = await pulseras.prepare(actor(), 1);
    const out = await pulseras.replace(actor(), old.id, fresh.firstLabel);
    expect(out).toMatchObject({ balanceCents: 1000, from: { status: 'BLOCKED' }, to: { status: 'ISSUED', label: fresh.firstLabel } });
    await expect(payWithBand(w, 100)).rejects.toBeTruthy();
    const newCard = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { number: fresh.first } }));
    expect(newCard).toMatchObject({ walletId: w.id, uid: null });
    // Dada desde el panel (sin leerla) no tiene número de serie: sin PIN no paga hasta leerla por NFC.
    await expect(payWithBand({ card: newCard.token, uid: 'AABBCCDDEEFF00' }, 100)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PIN_REQUIRED' }) });
    await sys((tx) => tx.walletCard.update({ where: { id: newCard.id }, data: { uid: 'AABBCCDDEEFF00' } }));
    await expect(payWithBand({ card: newCard.token, uid: 'AABBCCDDEEFF00' }, 100)).resolves.toMatchObject({ status: 'ACCEPTED' });
    // Una pulsera que no está libre no vale.
    await expect(pulseras.replace(actor(), out.to.id, old.label)).rejects.toMatchObject({ status: 409 });
  });
});

describe('la base', () => {
  it('el IBAN solo y siempre en la transferencia; método y estado conocidos; hecha con fecha', async () => {
    const w = await wallet(100);
    const row = (data: Record<string, unknown>) =>
      sys((tx) => tx.partyRefundRequest.create({ data: { tenantId: V, walletId: w.id, amountCents: 100, method: 'CARD', ...data } as never }));
    await expect(row({ method: 'TRANSFER', holderName: HOLDER })).rejects.toThrow(/party_refund_requests_iban_check/);
    await expect(row({ method: 'CARD', iban: IBAN })).rejects.toThrow(/party_refund_requests_iban_check/);
    await expect(row({ method: 'TRANSFER', iban: 'es91 2100', holderName: HOLDER })).rejects.toThrow(/party_refund_requests_iban_check/);
    // El titular, igual: siempre en una transferencia pendiente, nunca en otra cosa, y no vacío.
    await expect(row({ method: 'TRANSFER', iban: IBAN })).rejects.toThrow(/party_refund_requests_holder_check/);
    await expect(row({ method: 'CARD', holderName: HOLDER })).rejects.toThrow(/party_refund_requests_holder_check/);
    await expect(row({ method: 'TRANSFER', iban: IBAN, holderName: '  ' })).rejects.toThrow(/party_refund_requests_holder_check/);
    await expect(row({ method: 'TRANSFER', iban: IBAN, holderName: HOLDER })).resolves.toMatchObject({ holderName: HOLDER });
    // Hecha o anulada: sin datos del asistente (sin IBAN ni titular sí vale).
    const done = { status: 'DONE', doneAt: new Date() };
    await expect(row({ method: 'TRANSFER', iban: IBAN, holderName: HOLDER, ...done })).rejects.toThrow(/party_refund_requests_personal_data_check/);
    await expect(row({ method: 'CARD', email: 'ana@correo.es', status: 'CANCELED' })).rejects.toThrow(/party_refund_requests_personal_data_check/);
    await expect(row({ method: 'TRANSFER', ...done })).resolves.toMatchObject({ iban: null, holderName: null, email: null });
    await expect(row({ method: 'BIZUM' })).rejects.toThrow(/party_refund_requests_method_check/);
    await expect(row({ status: 'DONE' })).rejects.toThrow(/party_refund_requests_done_check/);
    await expect(row({ amountCents: 0 })).rejects.toThrow(/party_refund_requests_amount_check/);
    await expect(row({ email: 'sin arroba' })).rejects.toThrow(/party_refund_requests_email_check/);
  });

  it('la migración se puede repetir', async () => {
    const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
    const file = join(__dirname, '../../../../packages/db/prisma/migrations/20261120300100_oxioparty_devoluciones/migration.sql');
    const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', file], {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const [t] = await sys((tx) => tx.$queryRaw<Array<{ forced: boolean }>>`
      SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = ${'party_refund_requests'}`);
    expect(t).toEqual({ forced: true });
  });
});
