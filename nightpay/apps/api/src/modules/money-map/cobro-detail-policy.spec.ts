import { describe, expect, it } from 'vitest';
import { shapeCobroDetail, type CobroDetailFacts, type DeviceFact } from './cobro-detail-policy';

const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const CARLOS = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03';
const ENCARGADO = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d06';
const UNTIL = '2026-11-08T00:30:00.000Z';

const device = (over: Partial<DeviceFact>): DeviceFact => ({
  who: 'staff',
  step: 'create',
  at: '2026-11-08T00:20:00.000Z',
  label: 'iPhone · iOS 18 · Safari 18',
  model: 'iPhone',
  os: 'iOS',
  osVersion: '18',
  browser: 'Safari 18',
  mobile: true,
  inApp: null,
  ip: '10.0.0.7',
  ipErased: false,
  personName: 'Lola',
  userId: LOLA,
  ...over,
});

/** Una copa con invitación que cobra Carlos (camarero) para Lola, pagada con tarjeta. */
const facts: CobroDetailFacts = {
  base: {
    kind: 'PAYMENT',
    id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
    ref: 'C-0024',
    confirmationCode: 'A6B',
    status: 'PARTIALLY_REFUNDED',
    createdAt: '2026-11-08T00:20:00.000Z',
    paidAt: '2026-11-08T00:23:00.000Z',
    venueName: 'Sala Bambú',
    sections: [{ category: 'VENUE_BAR', amountCents: 4000 }],
    lines: [{ label: 'Copa con invitación', qty: 2, unitCents: 2000, amountCents: 4000, category: 'VENUE_BAR', invitedName: 'Lola' }],
    service: '2× Copa con invitación',
    isTopUp: false,
    amountCents: 4000,
    tipCents: 300,
    serviceFeeCents: 400,
    totalCents: 4700,
    method: { method: 'CARD', label: 'Tarjeta Visa ••4242', cardBrand: 'Visa', cardLast4: '4242', fichaNumber: null, via: 'QR', walletHint: null },
    undo: [{ kind: 'REFUND', at: '2026-11-08T01:00:00.000Z', amountCents: 1000, by: 'Encargado Javi', reason: 'Copa derramada', status: 'SUCCEEDED' }],
  },
  chargedBy: { name: 'Carlos Pérez', displayName: 'Carlos Pérez', role: 'WAITER' },
  flags: ['NO_3DS', 'FOREIGN_CARD', 'PAID_TWICE'],
  balance: null,
  shares: [
    { personId: CARLOS, name: 'Carlos Pérez', role: 'WAITER', commissionCents: 0, tipCents: 300, invitationCents: 400, reversedCents: 100, totalCents: 600 },
    { personId: LOLA, name: 'Lola', role: 'OPERATOR', commissionCents: 0, tipCents: 0, invitationCents: 1600, reversedCents: 400, totalCents: 1200 },
  ],
  split: { soldCents: 4300, refundedCents: 1000, staff: [], oxioPay: { serviceFeeCents: 300, platformCents: 0 }, venueCents: 1500 },
  bank: { authCode: '123456', secure3ds: false, cardCountry: '826', provider: 'REDSYS', bankOrder: '1108A6B' },
  panelUrl: 'https://admin.paytomaxx.com/?s=hoy&t=cobros&ref=C-0024',
  devices: [
    device({ who: 'staff', step: 'create', userId: CARLOS, personName: 'Carlos Pérez' }),
    device({ who: 'client', step: 'card', userId: null, personName: null, model: 'SM-S918B', ip: '83.45.120.7' }),
    device({ who: 'staff', step: 'cancel', userId: ENCARGADO, personName: 'Encargado Javi', ip: '10.0.0.9' }),
  ],
  card: { type: 'C', payMethodCode: 'C', expiry: null, tokenized: false },
  history: [{ at: '2026-11-08T00:23:00.000Z', what: 'Pagado', detail: 'Pedido 1108A6B' }],
};

const BASE_KEYS = [
  'kind',
  'id',
  'ref',
  'confirmationCode',
  'status',
  'createdAt',
  'paidAt',
  'venueName',
  'sections',
  'lines',
  'service',
  'isTopUp',
  'amountCents',
  'tipCents',
  'serviceFeeCents',
  'totalCents',
  'method',
  'undo',
  'audience',
  'chargedBy',
  'flags',
];
const sorted = (keys: string[]) => [...keys].sort();

describe('qué ve cada uno del detalle de un cobro', () => {
  it('el cliente: lo básico y el saldo antes y después; nada del personal, del banco ni delicado', () => {
    const d = shapeCobroDetail(facts, { audience: 'CLIENT' }, null);
    expect(sorted(Object.keys(d))).toEqual(sorted([...BASE_KEYS, 'balance']));
    // «Te cobró: Carlos»: solo el nombre de pila, sin puesto.
    expect(d.chargedBy).toEqual({ name: 'Carlos', role: null });
    // Anulado o devuelto: qué y cuándo, nunca quién ni por qué (texto interno).
    expect(d.undo).toEqual([{ kind: 'REFUND', at: '2026-11-08T01:00:00.000Z', amountCents: 1000, by: null, reason: null, status: 'SUCCEEDED' }]);
    expect(d.flags).toEqual([]);
    expect(JSON.stringify(d)).not.toMatch(/83\.45|SM-S918B|1108A6B|123456/);
  });

  it('la chica o el camarero sin verificar: lo básico y lo suyo; ni la parte del local ni la de los demás', () => {
    const d = shapeCobroDetail(facts, { audience: 'STAFF', userId: CARLOS }, { verifiedUntil: null, method: 'totp' });
    expect(sorted(Object.keys(d))).toEqual(sorted([...BASE_KEYS, 'mine', 'panelUrl', 'sensitive', 'verify']));
    expect(d.mine).toEqual({ commissionCents: 0, tipCents: 300, invitationCents: 400, reversedCents: 100, totalCents: 600 });
    expect(d.sensitive).toBeNull();
    expect(d.verify).toEqual({ required: true, method: 'totp', verifiedUntil: null });
    // Sus señales: no las del banco (3DS, país de la tarjeta).
    expect(d.flags).toEqual(['PAID_TWICE']);
    const text = JSON.stringify(d);
    expect(text).not.toContain('1600'); // lo de Lola
    expect(text).not.toContain('venueCents');
    expect(text).not.toMatch(/83\.45|10\.0\.0/);
  });

  it('quien quita, pone o anula ve quién y por qué (el personal y el panel)', () => {
    const d = shapeCobroDetail(facts, { audience: 'STAFF', userId: CARLOS }, null);
    expect(d.undo[0]).toMatchObject({ by: 'Encargado Javi', reason: 'Copa derramada' });
  });

  it('la chica verificada: el historial y su propio dispositivo, nunca el del cliente ni el de otros', () => {
    const d = shapeCobroDetail(facts, { audience: 'STAFF', userId: CARLOS }, { verifiedUntil: UNTIL, method: 'totp' });
    expect(d.verify).toEqual({ required: false, method: 'totp', verifiedUntil: UNTIL });
    expect(d.sensitive?.devices.map((x) => [x.who, x.step, x.personName])).toEqual([['staff', 'create', 'Carlos Pérez']]);
    expect(d.sensitive?.card).toBeNull();
    expect(d.sensitive?.history).toHaveLength(1);
    expect(JSON.stringify(d)).not.toContain('83.45.120.7');
  });

  it('a quien el cobro no le da nada: «lo tuyo» null', () => {
    const d = shapeCobroDetail(facts, { audience: 'STAFF', userId: ENCARGADO }, null);
    expect(d.mine).toBeNull();
  });

  it('el encargado sin «Informes»: lo del banco y las señales, sin el reparto; lo delicado, null hasta verificarse', () => {
    const d = shapeCobroDetail(facts, { audience: 'MANAGER', userId: ENCARGADO, role: 'MANAGER', canSeeSplit: false }, { verifiedUntil: null, method: 'totp' });
    expect(sorted(Object.keys(d))).toEqual(sorted([...BASE_KEYS, 'bank', 'panelUrl', 'sensitive', 'verify']));
    expect(d.bank).toEqual(facts.bank);
    expect(d.flags).toEqual(['NO_3DS', 'FOREIGN_CARD', 'PAID_TWICE']);
    expect(d.sensitive).toBeNull();
    expect(d.verify?.required).toBe(true);
  });

  it('el dueño verificado: el reparto entero, todos los dispositivos con su IP (también el del cliente), la tarjeta y el historial', () => {
    const d = shapeCobroDetail(facts, { audience: 'MANAGER', userId: ENCARGADO, role: 'OWNER', canSeeSplit: true }, { verifiedUntil: UNTIL, method: 'passkey' });
    expect(sorted(Object.keys(d))).toEqual(sorted([...BASE_KEYS, 'split', 'bank', 'panelUrl', 'sensitive', 'verify']));
    expect(d.split).toEqual(facts.split);
    expect(d.sensitive?.devices.map((x) => [x.who, x.ip])).toEqual([
      ['staff', '10.0.0.7'],
      ['client', '83.45.120.7'],
      ['staff', '10.0.0.9'],
    ]);
    // Sin el id de la persona (es interno).
    expect(d.sensitive?.devices[0]).not.toHaveProperty('userId');
    expect(d.sensitive?.card).toEqual(facts.card);
  });
});
