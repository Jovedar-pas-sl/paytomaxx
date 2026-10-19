import { describe, it, expect } from 'vitest';
import type { NightCash, NightCloseStep } from '@nightpay/contracts';
import {
  cashInputOf,
  cashOutcome,
  diffLabel,
  effectiveSteps,
  freezeState,
  keepAcks,
  parseCashInput,
  readyCount,
  stepTab,
  stepsFromBody,
  toggleAck,
} from './night-close';
import { PANEL_TABS, visibleTabs } from './roles';

const CASH: NightCash = {
  openingFloatCents: 20_000,
  cashInCents: 0,
  walletCashPayoutsCount: 1,
  walletCashPayoutsCents: 4500,
  chicaCashPayoutsCount: 1,
  chicaCashPayoutsCents: 9000,
  cashOutCents: 13_500,
  expectedCents: 6500,
};

function step(key: NightCloseStep['key'], status: NightCloseStep['status'], title: string = key): NightCloseStep {
  return { key, status, title, detail: '', count: 0, link: null, items: [] };
}

/** Los siete pasos como los manda el API (efectivo bloqueando hasta contar). */
const STEPS: NightCloseStep[] = [
  step('cobros', 'ok', 'Cobros sin terminar'),
  step('datafonos', 'ok', 'Datáfonos'),
  step('saldo', 'warn', 'Saldo devuelto pendiente'),
  step('efectivo', 'block', 'Efectivo'),
  step('chicas', 'ok', 'Pagar a las chicas'),
  step('incidencias', 'ok', 'Incidencias abiertas'),
  step('z', 'ok', 'Congelar el Z'),
];

describe('efectivo tecleado', () => {
  it('vacío = sin poner; 0 vale; importes en español; lo demás no es un importe', () => {
    expect(parseCashInput('')).toBeUndefined();
    expect(parseCashInput('   ')).toBeUndefined();
    expect(parseCashInput('0')).toBe(0);
    expect(parseCashInput('0,00')).toBe(0);
    expect(parseCashInput('65')).toBe(6500);
    expect(parseCashInput('60,5')).toBe(6050);
    expect(parseCashInput('1.234,56')).toBe(123_456);
    expect(parseCashInput('12abc')).toBeNull();
    expect(parseCashInput('-5')).toBeNull();
  });

  it('a la entrada de las reglas: lo que no es un importe cuenta como vacío', () => {
    expect(cashInputOf({ floatText: '', countedText: '60' })).toEqual({ openingFloatCents: undefined, countedCents: 6000 });
    expect(cashInputOf({ floatText: 'x', countedText: '0' })).toEqual({ openingFloatCents: undefined, countedCents: 0 });
  });

  it('esperado, contado y diferencia como en el API', () => {
    expect(cashOutcome(CASH, { floatText: '', countedText: '60' })).toMatchObject({
      expectedCents: 6500,
      countedCents: 6000,
      diffCents: -500,
      status: 'warn',
    });
    // El fondo tecleado corrige el guardado.
    expect(cashOutcome(CASH, { floatText: '205', countedText: '70' })).toMatchObject({ expectedCents: 7000, diffCents: 0 });
  });

  it('la diferencia en palabras', () => {
    expect(diffLabel(-1250)).toMatch(/^Faltan 12,50\s€$/);
    expect(diffLabel(500)).toMatch(/^Sobran 5,00\s€$/);
    expect(diffLabel(0)).toBe('Cuadra');
  });
});

describe('«Congelar el Z»', () => {
  it('no se puede mientras algo bloquea (el efectivo sin contar)', () => {
    const steps = effectiveSteps(STEPS, CASH, { floatText: '', countedText: '' });
    expect(freezeState(steps, ['saldo'], '')).toEqual({
      canFreeze: false,
      reason: 'Falta resolver: «Efectivo».',
      noteRequired: false,
    });
  });

  it('contada y cuadrada, falta confirmar los avisos', () => {
    const steps = effectiveSteps(STEPS, CASH, { floatText: '', countedText: '65' });
    expect(freezeState(steps, [], '')).toMatchObject({
      canFreeze: false,
      reason: 'Confirma que lo has visto: «Saldo devuelto pendiente».',
    });
    expect(freezeState(steps, ['saldo'], '')).toEqual({ canFreeze: true, reason: null, noteRequired: false });
  });

  it('si no cuadra, la diferencia también se confirma', () => {
    const steps = effectiveSteps(STEPS, CASH, { floatText: '', countedText: '60' });
    expect(freezeState(steps, ['saldo'], '').reason).toBe('Confirma que lo has visto: «Efectivo».');
    expect(freezeState(steps, ['saldo', 'efectivo'], '').canFreeze).toBe(true);
  });

  it('con cobros sin terminar, la nota (como el API)', () => {
    const steps = [step('cobros', 'warn', 'Cobros sin terminar'), step('z', 'ok')];
    expect(freezeState(steps, ['cobros'], '')).toEqual({
      canFreeze: false,
      reason: 'Escribe por qué cierras con cobros sin terminar.',
      noteRequired: true,
    });
    expect(freezeState(steps, ['cobros'], 'BBVA mañana').canFreeze).toBe(true);
  });

  it('cuántos pasos están listos: los ok y los avisos confirmados', () => {
    const steps = effectiveSteps(STEPS, CASH, { floatText: '', countedText: '65' });
    expect(readyCount(steps)).toBe(6);
    expect(readyCount(steps, ['saldo'])).toBe(7);
  });
});

describe('avisos confirmados', () => {
  it('marcar y desmarcar sin tocar la lista de entrada', () => {
    const acks = ['saldo'] as const;
    expect(toggleAck(acks, 'incidencias', true)).toEqual(['saldo', 'incidencias']);
    expect(toggleAck(acks, 'saldo', false)).toEqual([]);
    expect(toggleAck(acks, 'saldo', true)).toEqual(['saldo']);
    expect(acks).toEqual(['saldo']);
  });

  it('al recargar, solo siguen los que siguen en aviso', () => {
    expect(keepAcks(['saldo', 'incidencias'], [step('saldo', 'ok'), step('incidencias', 'warn')])).toEqual(['incidencias']);
  });
});

describe('a dónde lleva cada paso', () => {
  it('a la pestaña si este rol la ve', () => {
    const tabs = visibleTabs({ role: 'MANAGER' });
    expect(stepTab('payments', tabs)?.label).toBe('Cobros');
    expect(stepTab('terminals', tabs)?.label).toBe('Datáfonos');
    expect(stepTab(null, tabs)).toBeNull();
    expect(stepTab('incidents', PANEL_TABS.filter((t) => t.key !== 'incidents'))).toBeNull();
  });
});

describe('pasos en un 409 del API', () => {
  it('los lee si vienen bien', () => {
    const body = JSON.stringify({ status: 409, code: 'NIGHT_CLOSE_BLOCKED', steps: STEPS });
    expect(stepsFromBody(body)?.map((s) => s.key)).toEqual(['cobros', 'datafonos', 'saldo', 'efectivo', 'chicas', 'incidencias', 'z']);
  });

  it('null si no son pasos', () => {
    expect(stepsFromBody('<html>')).toBeNull();
    expect(stepsFromBody(JSON.stringify({ detail: 'x' }))).toBeNull();
    expect(stepsFromBody(JSON.stringify({ steps: [{ key: 'otro', status: 'ok', title: '', detail: '', items: [] }] }))).toBeNull();
  });
});
