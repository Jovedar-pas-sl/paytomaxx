import { describe, expect, it } from 'vitest';
import { staffPermissionsOf } from '@nightpay/contracts';
import type { VenueSettings } from './endpoints/settings';
import {
  PERMISSION_LABELS,
  ROLE_LABELS,
  editablePermissions,
  hasOverride,
  holdDaysText,
  parseTipEuros,
  parseTipPercents,
  personCan,
  rulesChange,
  rulesFormFrom,
  tipEurosText,
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

  it('el encargado: los seis; el camarero y el datáfono de recepción: solo las recargas en efectivo', () => {
    expect(editablePermissions('MANAGER')).toHaveLength(6);
    expect(editablePermissions('WAITER')).toEqual(['cashTopUp']);
    expect(editablePermissions('DEVICE')).toEqual(['cashTopUp']);
    expect(PERMISSION_LABELS.cashTopUp).toBe('Cobrar recargas en efectivo');
    expect(ROLE_LABELS.DEVICE).toBe('Datáfonos de recepción');
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
