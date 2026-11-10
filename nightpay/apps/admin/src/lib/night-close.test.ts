import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { NightCash, NightCloseStep } from '@nightpay/contracts';
import {
  cajaInText,
  cajaOutText,
  cashInputOf,
  cashOutcome,
  diffLabel,
  effectiveSteps,
  floatChangeCode,
  ackedKeys,
  freezeState,
  parseCashInput,
  pendingHeading,
  pendingTodo,
  readyCount,
  stepTab,
  stepsFromBody,
  toggleAck,
} from './night-close';
import { PANEL_TABS, visibleTabs } from './roles';

const CASH: NightCash = {
  openingFloatCents: 20_000,
  cashInCents: 0,
  walletCashTopUpsCount: 0,
  walletCashTopUpsCents: 0,
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
  step('chicas', 'ok', 'Pagar al personal'),
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

  it('las recargas en efectivo entran: esperado = fondo + recargas − salidas', () => {
    const conRecargas: NightCash = { ...CASH, cashInCents: 8000, walletCashTopUpsCount: 2, walletCashTopUpsCents: 8000 };
    expect(cashOutcome(conRecargas, { floatText: '', countedText: '145' })).toMatchObject({ expectedCents: 14_500, diffCents: 0 });
    const steps = effectiveSteps([step('efectivo', 'block')], conRecargas, { floatText: '', countedText: '145' });
    expect(steps[0]).toMatchObject({ status: 'ok', count: 4 });
  });

  it('el bloque «Caja» dice las recargas en efectivo (los Z de antes, sin el número)', () => {
    // Intl pone un espacio duro antes del €.
    expect(cajaInText({ cashInCents: 8000, walletCashTopUpsCount: 2, walletCashTopUpsCents: 8000 })).toMatch(
      /^Recargas del saldo en efectivo: 80,00\s€ \(2\)\.$/,
    );
    expect(cajaInText({ cashInCents: 500 })).toMatch(/^Recargas del saldo en efectivo: 5,00\s€\.$/);
  });

  it('con la comisión del servicio de esas recargas: en la caja, pero se debe a OxioPay', () => {
    const sp = (t: string) => t.replace(/\u00a0/g, ' ');
    expect(sp(cajaInText({ cashInCents: 5600, walletCashTopUpsCount: 1, walletCashTopUpsCents: 5000, walletCashTopUpFeesCents: 600 }))).toBe(
      'Recargas del saldo en efectivo: 50,00 € (1) + 6,00 € de comisión del servicio (se debe a OxioPay).',
    );
  });

  it('el bloque «Caja» dice lo que salió: a las chicas y, aparte, a los camareros (los Z de antes, «al personal»)', () => {
    const sp = (t: string) => t.replace(/\u00a0/g, ' ');
    const out = { walletCashPayoutsCount: 1, walletCashPayoutsCents: 4500, chicaCashPayoutsCount: 1, chicaCashPayoutsCents: 751 };
    expect(sp(cajaOutText({ ...out, camareroCashPayoutsCount: 1, camareroCashPayoutsCents: 750 }))).toBe(
      'Saldo devuelto en efectivo: 45,00 € (1) · pagos a las chicas en efectivo: 7,51 € (1) · a los camareros: 7,50 € (1).',
    );
    expect(sp(cajaOutText({ ...out, camareroCashPayoutsCount: 0, camareroCashPayoutsCents: 0 }))).toBe(
      'Saldo devuelto en efectivo: 45,00 € (1) · pagos a las chicas en efectivo: 7,51 € (1).',
    );
    // Un Z congelado antes (sin el campo): sus pagos eran de todo el personal.
    expect(sp(cajaOutText(out))).toBe('Saldo devuelto en efectivo: 45,00 € (1) · pagos al personal en efectivo: 7,51 € (1).');
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
  const saldo = step('saldo', 'warn');
  const incidencias = step('incidencias', 'warn');

  it('marcar y desmarcar sin tocar la lista de entrada', () => {
    const acks = toggleAck([], saldo, true);
    expect(ackedKeys(toggleAck(acks, incidencias, true), [saldo, incidencias])).toEqual(['saldo', 'incidencias']);
    expect(toggleAck(acks, saldo, false)).toEqual([]);
    expect(ackedKeys(toggleAck(acks, saldo, true), [saldo])).toEqual(['saldo']);
    expect(ackedKeys(acks, [saldo])).toEqual(['saldo']);
  });

  it('al recargar, solo siguen los que siguen en aviso', () => {
    const acks = toggleAck(toggleAck([], saldo, true), incidencias, true);
    expect(ackedKeys(acks, [step('saldo', 'ok'), incidencias])).toEqual(['incidencias']);
  });

  it('si el aviso cambia (otro importe u otro recuento), hay que volver a confirmarlo', () => {
    const efectivo = { ...step('efectivo', 'warn'), detail: 'Faltan 12,50 €', count: 3 };
    const acks = toggleAck([], efectivo, true);
    expect(ackedKeys(acks, [efectivo])).toEqual(['efectivo']);
    expect(ackedKeys(acks, [{ ...efectivo, detail: 'Faltan 32,50 €' }])).toEqual([]);
    expect(ackedKeys(acks, [{ ...efectivo, count: 4 }])).toEqual([]);
    const chicas = {
      ...step('chicas', 'warn'),
      detail: 'Quedan 2 chicas: 300,00 €',
      items: [{ id: 'c1', status: 'warn' as const, label: 'Ana (hace 3 min)', amountCents: 15_000 }],
    };
    const chicaAck = toggleAck([], chicas, true);
    // La etiqueta lleva «hace N min»: cambiarla no cuenta como otro aviso; otro importe, sí.
    expect(ackedKeys(chicaAck, [{ ...chicas, items: [{ ...chicas.items[0]!, label: 'Ana (hace 4 min)' }] }])).toEqual(['chicas']);
    expect(ackedKeys(chicaAck, [{ ...chicas, items: [{ ...chicas.items[0]!, amountCents: 20_000 }] }])).toEqual([]);
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

describe('cambiar al cerrar el fondo apuntado al abrir', () => {
  // CASH: fondo 200 € apuntado al abrir; salieron 135 € (lo esperado, 65 €).
  const changed = { floatText: '150', countedText: '15' };
  const same = { floatText: '200', countedText: '65' };

  it('sin cambiar el fondo no hace falta código', () => {
    expect(floatChangeCode(CASH, same, { isOwner: true, code: '' })).toEqual({ needed: false });
    expect(floatChangeCode(CASH, { floatText: '', countedText: '65' }, { isOwner: false, code: '' })).toEqual({ needed: false });
  });

  it('cambiado: bloquea el paso hasta que el dueño pone su código; el encargado no puede', () => {
    expect(cashOutcome(CASH, changed)).toMatchObject({ reason: 'float-changed', status: 'block' });
    expect(floatChangeCode(CASH, changed, { isOwner: false, code: '123456' })).toEqual({ needed: true, code: undefined });
    expect(floatChangeCode(CASH, changed, { isOwner: true, code: '123' })).toEqual({ needed: true, code: undefined });
    expect(floatChangeCode(CASH, changed, { isOwner: true, code: '123456' })).toEqual({ needed: true, code: '123456' });
    const efectivo = (approved: boolean) => effectiveSteps(STEPS, CASH, changed, approved).find((s) => s.key === 'efectivo');
    expect(efectivo(false)?.status).toBe('block');
    expect(efectivo(true)?.status).toBe('ok');
  });

  it('lo esperado negativo bloquea con el texto de las reglas', () => {
    expect(cashOutcome(CASH, { floatText: '', countedText: '0' }, false).reason).not.toBe('negative');
    const noFloat = { ...CASH, openingFloatCents: 0 };
    expect(cashOutcome(noFloat, { floatText: '', countedText: '0' })).toMatchObject({ reason: 'negative', status: 'block' });
  });
});

describe('cobros sin resolver al cerrar: qué hacer con cada uno (no todos tienen «Resolver» en Hoy → Cobros)', () => {
  it('el título manda a cada línea, no a una pantalla', () => {
    expect(pendingHeading(1)).toBe('1 cobro sin resolver. Antes de cerrar, haz lo que dice cada uno:');
    expect(pendingHeading(3)).toBe('3 cobros sin resolver. Antes de cerrar, haz lo que dice cada uno:');
  });

  it('cada caso, su salida: el datáfono se confirma con el ticket o caduca; «Resolver» solo con el banco sin confirmar o pasados 15 min', () => {
    expect(pendingTodo({ status: 'AWAITING_CAPTURE', captureMethod: 'POS_EXTERNAL' })).toBe(
      'datáfono sin confirmar: que quien cobró lo confirme con el ticket en la app, o caduca solo',
    );
    expect(pendingTodo({ status: 'ORPHAN', captureMethod: 'REDSYS' })).toContain('«Resolver» en Hoy → Cobros');
    expect(pendingTodo({ status: 'AUTHORIZING', captureMethod: 'REDSYS' })).toContain('si a los 15 min sigue, «Resolver»');
    expect(pendingTodo({ status: 'CREATED', captureMethod: 'WALLET_TOPUP' })).toBe('recarga en el datáfono a medias: se termina en el datáfono o caduca sola');
    expect(pendingTodo({ status: 'CREATED', captureMethod: 'WALLET_TOPUP' })).not.toContain('Resolver');
  });

  it('Noches los usa (ya no dice «resuélvelos en Hoy → Cobros»)', () => {
    const panel = readFileSync(new URL('../components/NightsPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain('{pendingHeading(current.pending.length)}');
    expect(panel).toContain('{pendingTodo(p)}');
    expect(panel).not.toContain('resuélvelos en Hoy → Cobros');
  });
});
