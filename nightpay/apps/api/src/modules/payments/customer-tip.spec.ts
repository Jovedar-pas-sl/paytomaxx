import { describe, expect, it } from 'vitest';
import { STAFF_TIP_REMOVED_CODE, customerTipProblem, maxTipCents, tipPresetsFor } from '@nightpay/contracts';
import { customerTipError, staffTipRemoved } from './tip';

// B1: la propina solo la pone el cliente al pagar (tarjeta, saldo o PIN).

describe('la propina que elige el cliente con su saldo o su PIN', () => {
  it('«Sin propina» siempre vale, también con las propinas apagadas', () => {
    expect(customerTipProblem({ amountCents: 1000, tipCents: 0, tipsOn: false })).toBeNull();
  });

  it('una propina, solo con las propinas encendidas (local y puesto) y hasta el importe y 500 €', () => {
    expect(customerTipProblem({ amountCents: 1000, tipCents: 500, tipsOn: true })).toBeNull();
    expect(customerTipProblem({ amountCents: 1000, tipCents: 1000, tipsOn: true })).toBeNull();
    expect(customerTipProblem({ amountCents: 1000, tipCents: 1001, tipsOn: true })).toBe('too-high');
    expect(customerTipProblem({ amountCents: 900_000, tipCents: 50_001, tipsOn: true })).toBe('too-high');
    expect(customerTipProblem({ amountCents: 1000, tipCents: 500, tipsOn: false })).toBe('tips-off');
  });

  it('lo que no es un importe entero de céntimos, no', () => {
    expect(customerTipProblem({ amountCents: 1000, tipCents: -1, tipsOn: true })).toBe('invalid');
    expect(customerTipProblem({ amountCents: 1000, tipCents: 2.5, tipsOn: true })).toBe('invalid');
  });

  it('la que ya traía un cobro de antes (puesta por el personal) se respeta aunque hoy no se pudiera', () => {
    expect(customerTipProblem({ amountCents: 1000, tipCents: 300, tipsOn: false, previousTipCents: 300 })).toBeNull();
  });

  it('el 400 de una propina que no vale lleva su código (la página lo traduce) y el motivo', () => {
    const err = customerTipError('too-high');
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: 'TIP_NOT_VALID', reason: 'too-high' });
  });
});

describe('la propina del personal al crear el cobro', () => {
  it('400 con su código y un texto que dice qué hacer', () => {
    const err = staffTipRemoved();
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: STAFF_TIP_REMOVED_CODE });
    expect(err.message).toMatch(/la elige el cliente al pagar/);
  });
});

describe('las sugeridas y el máximo (en contracts: también los usa la pantalla del PIN)', () => {
  it('como antes: +2 € y +5 € hasta 40 €; por encima, 10 % y 15 %', () => {
    expect(tipPresetsFor(3300).map((p) => p.cents)).toEqual([200, 500]);
    expect(tipPresetsFor(6000).map((p) => p.cents)).toEqual([600, 900]);
    expect(maxTipCents(3300)).toBe(3300);
    expect(maxTipCents(900_000)).toBe(500_00);
  });
});
