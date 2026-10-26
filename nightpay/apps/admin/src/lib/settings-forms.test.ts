import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, sectionsOf, staffPermissionsOf } from '@nightpay/contracts';
import type { VenueSettings } from './endpoints/settings';
import {
  PERMISSION_HINTS,
  PERMISSION_LABELS,
  ROLE_LABELS,
  commissionFields,
  editablePermissions,
  hasOverride,
  holdDaysText,
  parseTipEuros,
  parseTipPercents,
  personCan,
  platformCommissionHint,
  rulesChange,
  rulesFormFrom,
  serviceFeeRulesText,
  tipEurosText,
  waiterHint,
} from './settings-forms';

const settings: VenueSettings = {
  id: 'v-1',
  name: 'Luna',
  slug: 'luna',
  timezone: 'Europe/Madrid',
  operatorMaxCobroCents: 20_000,
  platformCommissionBps: 1000,
  operatorCommissionDefaults: { CHICA_SERVICE: 9000, VENUE_BAR: 0, VENUE_ROOM: 0, VENUE_FOOD: 0, EXTRA: 0 },
  payoutHoldDays: null,
  effectivePayoutHoldDays: 7,
  refundApprovalThresholdCents: 10_000,
  payoutRequiresApproval: true,
};

describe('reglas del local: los nombres de sección del local', () => {
  it('cada comisión con el nombre de Ajustes → Secciones; los de fábrica si no se cambiaron; «Otros» sin sección', () => {
    const own = sectionsOf({ CHICA_SERVICE: { label: 'Reservados VIP' }, VENUE_ENTRY: { label: 'Puerta' } });
    const fields = commissionFields(own);
    expect(fields.map((f) => f.key)).toEqual(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY', 'EXTRA']);
    expect(fields.find((f) => f.key === 'CHICA_SERVICE')?.label).toBe('Reservados VIP');
    expect(fields.find((f) => f.key === 'VENUE_ENTRY')?.label).toBe('Puerta');
    expect(fields.find((f) => f.key === 'VENUE_BAR')?.label).toBe(DEFAULT_SECTIONS.VENUE_BAR.label);
    expect(fields.find((f) => f.key === 'EXTRA')?.label).toBe('Otros');
  });

  it('el aviso de un porcentaje malo dice el nombre del local', () => {
    const own = sectionsOf({ CHICA_SERVICE: { label: 'Reservados VIP' } });
    const form = { ...rulesFormFrom(settings), commissions: { ...rulesFormFrom(settings).commissions, CHICA_SERVICE: 'mucho' } };
    expect(rulesChange(form, settings, commissionFields(own))).toMatchObject({ ok: false, problem: expect.stringMatching(/^Reservados VIP:/) });
  });
});

describe('reglas del local', () => {
  it('sin tocar nada: no hay cambios que mandar', () => {
    expect(rulesChange(rulesFormFrom(settings), settings)).toEqual({ ok: true, change: {} });
  });

  it('solo se manda lo que cambia; días a 0 = al cerrar la noche; vacío = lo del servidor', () => {
    const form = { ...rulesFormFrom(settings), maxCobroEur: '250', holdDays: '0', refundThresholdEur: '0' };
    form.commissions = { ...form.commissions, VENUE_BAR: '5' };
    expect(rulesChange(form, settings)).toEqual({
      ok: true,
      change: {
        operatorMaxCobroCents: 25_000,
        operatorCommissionDefaults: { VENUE_BAR: 500 },
        payoutHoldDays: 0,
        refundApprovalThresholdCents: 0,
      },
    });
    const back = rulesChange({ ...rulesFormFrom({ ...settings, payoutHoldDays: 3 }), holdDays: '' }, { ...settings, payoutHoldDays: 3 });
    expect(back).toEqual({ ok: true, change: { payoutHoldDays: null } });
  });

  it('chica + OxioPay por encima del 100 %: no se manda (como el API y la consola)', () => {
    const form = rulesFormFrom(settings);
    form.commissions = { ...form.commissions, CHICA_SERVICE: '95' };
    const res = rulesChange(form, settings);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problem).toMatch(/pasa del 100 %/);
  });

  it('valores que no valen: tope, %, días y umbral', () => {
    const base = rulesFormFrom(settings);
    expect(rulesChange({ ...base, maxCobroEur: '0' }, settings).ok).toBe(false);
    expect(rulesChange({ ...base, maxCobroEur: '20000' }, settings).ok).toBe(false);
    expect(rulesChange({ ...base, holdDays: '61' }, settings).ok).toBe(false);
    expect(rulesChange({ ...base, holdDays: '-1' }, settings).ok).toBe(false);
    expect(rulesChange({ ...base, refundThresholdEur: 'mucho' }, settings).ok).toBe(false);
    expect(rulesChange({ ...base, commissions: { ...base.commissions, EXTRA: '10abc' } }, settings).ok).toBe(false);
  });

  it('cómo se lee la espera', () => {
    expect(holdDaysText(0)).toBe('Se les paga al cerrar la noche');
    expect(holdDaysText(1)).toBe('Se les paga al día siguiente');
    expect(holdDaysText(7)).toBe('Se les paga a los 7 días');
  });
});

describe('propinas sugeridas', () => {
  it('euros enteros de 1 a 50, como mucho 3, ordenados sin repetir', () => {
    expect(parseTipEuros('5, 2')).toEqual([200, 500]);
    expect(parseTipEuros('2 2 3')).toEqual([200, 300]);
    expect(parseTipEuros('')).toBeNull();
    expect(parseTipEuros('1,2,3,4')).toBeNull();
    expect(parseTipEuros('0')).toBeNull();
    expect(parseTipEuros('2,5')).toEqual([200, 500]);
    expect(parseTipEuros('2.5')).toBeNull();
    expect(tipEurosText([200, 500])).toBe('2, 5');
  });

  it('porcentajes de 1 a 50', () => {
    expect(parseTipPercents('15 %, 10 %')).toEqual([10, 15]);
    expect(parseTipPercents('60')).toBeNull();
  });
});

describe('permisos del personal', () => {
  const manager = { id: 'm-1', role: 'MANAGER' as const };

  it('el encargado: los seis; el camarero: recargas y salida en efectivo; el datáfono de recepción: solo las recargas', () => {
    expect(editablePermissions('MANAGER')).toHaveLength(6);
    expect(editablePermissions('MANAGER')).not.toContain('cashPayout');
    expect(editablePermissions('WAITER')).toEqual(['cashTopUp', 'cashPayout']);
    expect(editablePermissions('DEVICE')).toEqual(['cashTopUp']);
    expect(PERMISSION_LABELS.cashTopUp).toBe('Cobrar recargas en efectivo');
    expect(ROLE_LABELS.DEVICE).toBe('Datáfonos de recepción');
  });

  it('devolver en efectivo a la salida: el camarero sí de fábrica (su puesto decide); se le quita a uno sin tocar sus recargas', () => {
    const perms = staffPermissionsOf({ people: { 'w-1': { cashPayout: false } } });
    expect(personCan(perms, { id: 'w-2', role: 'WAITER' }, 'cashPayout')).toBe(true);
    expect(personCan(perms, { id: 'w-1', role: 'WAITER' }, 'cashPayout')).toBe(false);
    expect(personCan(perms, { id: 'w-1', role: 'WAITER' }, 'cashTopUp')).toBe(false);
    expect(personCan(perms, manager, 'cashPayout')).toBe(false);
    expect(PERMISSION_HINTS.cashPayout).toMatch(/Recepción/);
  });

  it('recargas en efectivo: por defecto el encargado sí, el camarero no; el dueño se lo da a uno', () => {
    const perms = staffPermissionsOf({ people: { 'w-1': { cashTopUp: true } } });
    expect(personCan(perms, manager, 'cashTopUp')).toBe(true);
    expect(personCan(perms, { id: 'w-2', role: 'WAITER' }, 'cashTopUp')).toBe(false);
    expect(personCan(perms, { id: 'w-1', role: 'WAITER' }, 'cashTopUp')).toBe(true);
    expect(hasOverride(perms, { id: 'w-1', role: 'WAITER' })).toBe(true);
  });

  it('lo de la persona manda sobre lo del rol; sin excepción, lo del rol', () => {
    const perms = staffPermissionsOf({ roles: { MANAGER: { refund: false } }, people: { 'm-1': { refund: true } } });
    expect(personCan(perms, manager, 'refund')).toBe(true);
    expect(personCan(perms, { id: 'm-2', role: 'MANAGER' }, 'refund')).toBe(false);
    expect(personCan(perms, { id: 'w-1', role: 'WAITER' }, 'refund')).toBe(false);
    expect(hasOverride(perms, manager)).toBe(true);
    // Una «excepción» igual a lo del rol no cuenta como excepción.
    expect(hasOverride(staffPermissionsOf({ people: { 'm-1': { refund: true } } }), manager)).toBe(false);
  });
});

describe('camareros con y sin datáfono', () => {
  it('sin datáfono en el local no se les habla de confirmarlo', () => {
    expect(waiterHint(true)).toMatch(/^Cobran y confirman datáfonos desde su app;/);
    expect(waiterHint(false)).toBe(
      'Cobran desde su app; de esto, solo pueden cobrar recargas en efectivo si se lo das y, los de recepción, devolver el saldo en efectivo a la salida.',
    );
    expect(waiterHint(false)).not.toMatch(/datáfono/i);
  });
});

describe('Ajustes → Reglas: la «Comisión del servicio al cliente» (solo se ve: la pone OxioPay)', () => {
  const sp = (s: string) => s.replace(/\s/g, ' ');
  const on: VenueSettings = { ...settings, platformCommissionBps: 1000, serviceFeeEnabled: true, serviceFeeBps: 1000, topUpServiceFeeBps: 1200 };

  it('encendida: los dos % con su ejemplo, y lo que no la lleva', () => {
    const t = serviceFeeRulesText(on);
    expect(t.status).toBe('Encendida');
    expect(t.lines.map(sp)).toEqual([
      'Pagos con tarjeta, Apple Pay, Google Pay o datáfono: 10 % encima (un cobro de 33 € → el cliente paga 36,30 €).',
      'Recargas del saldo (tarjeta o efectivo): 12 % encima (recarga 50 € → paga 56 €; le quedan 50 € de saldo).',
      'Gastar del saldo y las propinas no la llevan. Es de OxioPay: entra con el resto del cobro y se apunta aparte.',
    ]);
  });

  it('apagada (o un API de antes, sin los campos): lo dice y no hay más', () => {
    expect(serviceFeeRulesText(settings)).toEqual({
      status: 'Apagada',
      lines: ['Los clientes pagan el precio, sin nada encima. La enciende OxioPay.'],
    });
  });

  it('la comisión de la plataforma: con la del servicio encendida, el local ya no la paga', () => {
    expect(sp(platformCommissionHint({ ...settings, platformCommissionBps: 1000 }))).toBe(
      'OxioPay se lleva el 10 % de cada cobro (lo cambia OxioPay). Lo de cada categoría es para quien crea el cobro; el resto, para el local.',
    );
    expect(sp(platformCommissionHint(on))).toBe(
      'Con la comisión del servicio encendida, OxioPay no se lleva nada de tus cobros: la paga el cliente encima. Lo de cada categoría es para quien crea el cobro; el resto, para el local.',
    );
  });
});
