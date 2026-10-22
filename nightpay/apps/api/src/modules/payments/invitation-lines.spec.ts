import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INVITATION_RULES,
  invitationRulesOf,
  invitationShareLabel,
  invitationShares,
  mergeInvitationRules,
  staffTokenFrom,
} from '@nightpay/contracts';
import { signStaffToken, staffQrSecret, verifyStaffToken, STAFF_QR_TTL_MS } from '../operators/staff-qr';
import type { CartaItemLike, DraftLine } from './charge-lines';
import { invitationEarnings, isInvitationLine, withInvitation } from './invitation-lines';

const INVITA: CartaItemLike = {
  id: 'inv-1',
  name: 'Invitar a una copa',
  priceCents: 2500,
  durationMin: null,
  category: 'VENUE_BAR',
  active: true,
  components: null,
  isInvitation: true,
};
const COPA: CartaItemLike = { ...INVITA, id: 'copa-1', name: 'Copa', priceCents: 1000, isInvitation: false };
const items = new Map([INVITA, COPA].map((i) => [i.id, i]));
const line = (item: CartaItemLike, qty = 1): DraftLine => ({
  category: 'VENUE_BAR',
  serviceItemId: item.id,
  label: item.name,
  qty,
  unitCents: item.priceCents,
  amountCents: item.priceCents * qty,
});

describe('partes de una invitación (Ajustes)', () => {
  it('de fábrica (maqueta 2.6): la chica 50 % y el camarero 50 %; 20 € = 10 € + 10 €', () => {
    expect(invitationRulesOf(null)).toEqual(DEFAULT_INVITATION_RULES);
    expect(invitationShares(invitationRulesOf(null), { unitCents: 2000, qty: 1 }, { getsShare: true })).toEqual({
      beneficiaryCents: 1000,
      chargerCents: 1000,
    });
    // Quien cobra no es camarero (dueño, encargado): su mitad, del local.
    expect(invitationShares(invitationRulesOf(null), { unitCents: 2000, qty: 1 }, { getsShare: false })).toEqual({
      beneficiaryCents: 1000,
      chargerCents: 0,
    });
  });

  it('unas partes guardadas no cambian con las de fábrica', () => {
    const saved = { chica: { kind: 'FIXED', cents: 800 }, camarero: { kind: 'PERCENT', bps: 0 }, inviteFirst: true, requireQr: true };
    expect(invitationRulesOf(saved)).toEqual(saved);
    expect(invitationShares(invitationRulesOf(saved), { unitCents: 2000, qty: 1 }, { getsShare: true })).toEqual({ beneficiaryCents: 800, chargerCents: 0 });
  });

  it('% o fijo por copa; nunca más que la venta (primero la chica, luego el camarero)', () => {
    const rules = mergeInvitationRules(null, { chica: { kind: 'FIXED', cents: 1500 }, camarero: { kind: 'PERCENT', bps: 2000 } });
    expect(invitationShares(rules, { unitCents: 2500, qty: 2 }, { getsShare: true })).toEqual({ beneficiaryCents: 3000, chargerCents: 1000 });
    const greedy = mergeInvitationRules(null, { chica: { kind: 'FIXED', cents: 2000 }, camarero: { kind: 'FIXED', cents: 2000 } });
    expect(invitationShares(greedy, { unitCents: 2500, qty: 1 }, { getsShare: true })).toEqual({ beneficiaryCents: 2000, chargerCents: 500 });
    // El encargado o el dueño que la cobra: su parte se queda en el local.
    expect(invitationShares(rules, { unitCents: 2500, qty: 1 }, { getsShare: false }).chargerCents).toBe(0);
  });

  it('lo guardado raro vuelve a lo de fábrica; el texto de cada parte', () => {
    expect(invitationRulesOf({ chica: { kind: 'PERCENT', bps: 99_999 }, camarero: 'x' })).toEqual(DEFAULT_INVITATION_RULES);
    expect(invitationShareLabel({ kind: 'PERCENT', bps: 5000 })).toBe('50 %');
    expect(invitationShareLabel({ kind: 'FIXED', cents: 500 })).toBe('5,00 € por copa');
  });
});

describe('líneas de una invitación', () => {
  it('solo las de invitación llevan a la chica y sus partes (fijadas al cobrar)', () => {
    const out = withInvitation([line(INVITA, 2), line(COPA)], items, {
      beneficiaryOperatorId: 'lola',
      rules: mergeInvitationRules(null, { camarero: { kind: 'PERCENT', bps: 1000 } }),
      chargerGetsShare: true,
    });
    expect(out[0]).toMatchObject({ beneficiaryOperatorId: 'lola', beneficiaryCents: 2500, chargerCents: 500 });
    expect(out[1]).not.toHaveProperty('beneficiaryOperatorId');
    expect(isInvitationLine(out[0]!, items)).toBe(true);
    expect(isInvitationLine({ serviceItemId: null }, items)).toBe(false);
  });

  it('ganancias: una por chica invitada y otra para el camarero si le toca', () => {
    const lines = [
      { id: 'l1', amountCents: 2500, beneficiaryOperatorId: 'lola', beneficiaryCents: 1250, chargerCents: 250 },
      { id: 'l2', amountCents: 2500, beneficiaryOperatorId: 'lola', beneficiaryCents: 1250, chargerCents: 250 },
      { id: 'l3', amountCents: 1000, beneficiaryOperatorId: null, beneficiaryCents: null, chargerCents: null },
    ];
    expect(invitationEarnings(lines, 'dani')).toEqual([
      { operatorId: 'lola', commissionCents: 2500, paymentAmountCents: 5000, commissionBps: 5000, paymentLineId: 'l1' },
      { operatorId: 'dani', commissionCents: 500, paymentAmountCents: 5000, commissionBps: 1000, paymentLineId: 'l1' },
    ]);
    // Sin parte para el camarero (o sin quien cobró): solo la chica.
    expect(invitationEarnings(lines.map((l) => ({ ...l, chargerCents: 0 })), 'dani').map((e) => e.operatorId)).toEqual(['lola']);
    expect(invitationEarnings(lines, null).map((e) => e.operatorId)).toEqual(['lola']);
  });
});

describe('«Mi QR» de la chica: firmado y de vida corta', () => {
  const secret = 'una-clave-del-servidor-de-mas-de-32-caracteres';
  const now = Date.parse('2026-10-23T23:00:00Z');

  it('dice quién es y de qué local mientras no caduca', () => {
    const { token, expiresAt } = signStaffToken({ userId: 'lola', tenantId: 'sala' }, now, secret);
    expect(expiresAt.getTime()).toBe(now + STAFF_QR_TTL_MS);
    expect(verifyStaffToken(token, now + 60_000, secret)).toEqual({ userId: 'lola', tenantId: 'sala' });
    expect(verifyStaffToken(token, now + STAFF_QR_TTL_MS, secret)).toBeNull();
  });

  it('otra clave, una firma tocada o un token cualquiera no valen', () => {
    const { token } = signStaffToken({ userId: 'lola', tenantId: 'sala' }, now, secret);
    expect(verifyStaffToken(token, now, `${secret}-otra`)).toBeNull();
    const [body] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'otra', t: 'sala', e: now + 999_999 })).toString('base64url');
    expect(verifyStaffToken(`${forged}.${token.split('.')[1]}`, now, secret)).toBeNull();
    expect(verifyStaffToken(`${body}.x`, now, secret)).toBeNull();
    expect(verifyStaffToken('nada', now, secret)).toBeNull();
    expect(verifyStaffToken(`${body}.${token.split('.')[1]}.extra`, now, secret)).toBeNull();
  });

  it('el QR lleva la app con ?invita=: se lee la URL entera o el token suelto', () => {
    const { token } = signStaffToken({ userId: 'lola', tenantId: 'sala' }, now, secret);
    expect(staffTokenFrom(`https://operator.oxiopay.es/?invita=${token}`)).toBe(token);
    expect(staffTokenFrom(token)).toBe(token);
    expect(staffTokenFrom('https://otra.cosa/?x=1')).toBeNull();
  });

  it('sin JWT_SECRET no se firma nada', () => {
    expect(() => staffQrSecret({})).toThrow(/JWT_SECRET/);
    expect(staffQrSecret({ JWT_SECRET: secret })).toBe(secret);
  });
});
