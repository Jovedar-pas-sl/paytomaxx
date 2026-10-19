import { describe, it, expect } from 'vitest';
import {
  CloseNightSchema,
  OpenNightSchema,
  evaluateCash,
  expectedCashCents,
  nightCloseRefusal,
  withCashInput,
  type NightCash,
  type NightCloseStep,
} from '@nightpay/contracts';

/** Reglas del cierre que comparten el API y el panel (@nightpay/contracts/night-close). */

const CASH: NightCash = {
  openingFloatCents: 20_000,
  cashInCents: 0,
  walletCashPayoutsCount: 1,
  walletCashPayoutsCents: 3000,
  chicaCashPayoutsCount: 1,
  chicaCashPayoutsCents: 9000,
  cashOutCents: 12_000,
  expectedCents: 8000,
};
const NO_CASH: NightCash = {
  ...CASH,
  openingFloatCents: null,
  walletCashPayoutsCount: 0,
  walletCashPayoutsCents: 0,
  chicaCashPayoutsCount: 0,
  chicaCashPayoutsCents: 0,
  cashOutCents: 0,
  expectedCents: 0,
};

function step(key: NightCloseStep['key'], status: NightCloseStep['status']): NightCloseStep {
  return { key, status, title: key, detail: `${key} ${status}`, count: 0, link: null, items: [] };
}

describe('efectivo esperado', () => {
  it('fondo + entradas − salidas; sin fondo cuenta como 0', () => {
    expect(expectedCashCents(20_000, { cashInCents: 0, cashOutCents: 12_000 })).toBe(8000);
    expect(expectedCashCents(null, { cashInCents: 0, cashOutCents: 5000 })).toBe(-5000);
  });
});

describe('el paso «Efectivo» con lo tecleado', () => {
  it('sin efectivo ni fondo: no hace falta contar', () => {
    expect(evaluateCash(NO_CASH)).toMatchObject({ reason: 'not-needed', status: 'ok', required: false, diffCents: null });
  });

  it('salió efectivo y nadie dijo el fondo → bloquea; con el fondo tecleado ya no', () => {
    const noFloat = { ...CASH, openingFloatCents: null, expectedCents: -12_000 };
    expect(evaluateCash(noFloat)).toMatchObject({ reason: 'float-missing', status: 'block' });
    expect(evaluateCash(noFloat, { openingFloatCents: 15_000, countedCents: 3000 })).toMatchObject({
      reason: 'matches',
      status: 'ok',
      floatCents: 15_000,
      expectedCents: 3000,
      diffCents: 0,
    });
  });

  it('hay que contar y no se ha contado → bloquea con lo que debería haber', () => {
    const o = evaluateCash(CASH);
    expect(o).toMatchObject({ reason: 'count-missing', status: 'block', required: true, expectedCents: 8000 });
    expect(o.detail).toBe('Cuenta el efectivo de la caja: debería haber 80,00 €.');
  });

  it('solo el fondo (sin movimientos) también se cuenta; contar 0 € vale', () => {
    const onlyFloat = { ...NO_CASH, openingFloatCents: 5000, expectedCents: 5000 };
    expect(evaluateCash(onlyFloat).status).toBe('block');
    expect(evaluateCash(onlyFloat, { countedCents: 0 })).toMatchObject({ reason: 'short', diffCents: -5000, status: 'warn' });
  });

  it('cuadra → listo; falta o sobra → aviso con la diferencia', () => {
    expect(evaluateCash(CASH, { countedCents: 8000 })).toMatchObject({ reason: 'matches', status: 'ok', diffCents: 0 });
    const short = evaluateCash(CASH, { countedCents: 6750 });
    expect(short).toMatchObject({ reason: 'short', status: 'warn', diffCents: -1250 });
    expect(short.detail).toContain('Faltan 12,50 €');
    expect(evaluateCash(CASH, { countedCents: 8500 })).toMatchObject({ reason: 'over', diffCents: 500 });
  });

  it('cambiar el fondo apuntado al abrir bloquea (aunque así cuadre); con el visto bueno del dueño, vale', () => {
    // Faltan 50 €: teclear un fondo 50 € más bajo haría que «cuadrase».
    const typed = { openingFloatCents: 15_000, countedCents: 3000 };
    expect(evaluateCash(CASH, typed)).toMatchObject({ status: 'block', reason: 'float-changed', floatChanged: true });
    expect(evaluateCash(CASH, typed).detail).toMatch(/200,00 €.*2FA.*los dos/);
    expect(evaluateCash(CASH, { ...typed, floatChangeApproved: true })).toMatchObject({
      status: 'ok',
      floatCents: 15_000,
      expectedCents: 3000,
      diffCents: 0,
    });
    // El mismo fondo tecleado no es un cambio; sin fondo guardado, se apunta al cerrar.
    expect(evaluateCash(CASH, { openingFloatCents: 20_000, countedCents: 8000 })).toMatchObject({ status: 'ok', floatChanged: false });
    expect(evaluateCash({ ...CASH, openingFloatCents: null }, { openingFloatCents: 25_000, countedCents: 13_000 })).toMatchObject({
      status: 'ok',
      floatCents: 25_000,
      diffCents: 0,
    });
  });

  it('lo esperado negativo bloquea (salió más efectivo del que entró más el fondo), aunque se cuente', () => {
    const out = evaluateCash({ ...CASH, openingFloatCents: 5000 }, { countedCents: 0 });
    expect(out).toMatchObject({ status: 'block', reason: 'negative', expectedCents: -7000 });
    expect(out.detail).toMatch(/negativo \(−70,00 €\)/);
    // Con el fondo tecleado a 0 (sin fondo guardado), también.
    expect(evaluateCash({ ...CASH, openingFloatCents: null }, { openingFloatCents: 0, countedCents: 0 })).toMatchObject({
      status: 'block',
      reason: 'negative',
    });
  });

  it('cerrar: el 2FA del dueño son 6 cifras', () => {
    expect(CloseNightSchema.safeParse({ totpCode: '123456' }).success).toBe(true);
    expect(CloseNightSchema.safeParse({ totpCode: '12345' }).success).toBe(false);
  });

  it('withCashInput solo cambia el paso «Efectivo» y no toca la lista original', () => {
    const steps = [step('cobros', 'warn'), step('efectivo', 'block')];
    const next = withCashInput(steps, CASH, { countedCents: 8000 });
    expect(next[0]).toBe(steps[0]);
    expect(next[1]).toMatchObject({ key: 'efectivo', status: 'ok', count: 2 });
    expect(steps[1]!.status).toBe('block');
  });
});

describe('qué impide congelar el Z', () => {
  it('primero lo que bloquea', () => {
    const r = nightCloseRefusal([step('cobros', 'block'), step('saldo', 'warn')], ['saldo'], 'x');
    expect(r).toEqual({ kind: 'blocked', steps: [expect.objectContaining({ key: 'cobros' })] });
  });

  it('después, los avisos sin confirmar', () => {
    const steps = [step('saldo', 'warn'), step('incidencias', 'warn'), step('z', 'ok')];
    expect(nightCloseRefusal(steps, ['saldo'], undefined)).toEqual({
      kind: 'needs-ack',
      steps: [expect.objectContaining({ key: 'incidencias' })],
    });
    expect(nightCloseRefusal(steps, ['saldo', 'incidencias'], undefined)).toBeNull();
  });

  it('con cobros sin terminar confirmados, hace falta la nota (3 letras)', () => {
    const steps = [step('cobros', 'warn')];
    expect(nightCloseRefusal(steps, ['cobros'], '  ')).toEqual({ kind: 'note-required' });
    expect(nightCloseRefusal(steps, ['cobros'], 'BBVA lo confirma mañana')).toBeNull();
  });

  it('todo en orden → se puede', () => {
    expect(nightCloseRefusal([step('cobros', 'ok'), step('z', 'ok')], [], undefined)).toBeNull();
  });
});

describe('cuerpos de abrir y cerrar', () => {
  it('cerrar: sin nada, ningún aviso confirmado', () => {
    expect(CloseNightSchema.parse({})).toEqual({ acknowledged: [] });
  });

  it('cerrar: céntimos enteros, no negativos, hasta 100.000 €; pasos conocidos', () => {
    expect(CloseNightSchema.parse({ cashCountedCents: 0, acknowledged: ['efectivo'], note: '  ok  ' })).toMatchObject({
      cashCountedCents: 0,
      acknowledged: ['efectivo'],
      note: 'ok',
    });
    expect(CloseNightSchema.safeParse({ cashCountedCents: -1 }).success).toBe(false);
    expect(CloseNightSchema.safeParse({ cashCountedCents: 10.5 }).success).toBe(false);
    expect(CloseNightSchema.safeParse({ openingFloatCents: 10_000_001 }).success).toBe(false);
    expect(CloseNightSchema.safeParse({ acknowledged: ['cualquiera'] }).success).toBe(false);
  });

  it('abrir: el fondo es opcional (sin cuerpo vale)', () => {
    expect(OpenNightSchema.parse(undefined)).toEqual({});
    expect(OpenNightSchema.parse({ openingFloatCents: 15_000 })).toEqual({ openingFloatCents: 15_000 });
  });
});
