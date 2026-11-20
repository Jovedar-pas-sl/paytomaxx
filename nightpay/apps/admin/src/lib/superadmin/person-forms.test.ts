import { describe, expect, it } from 'vitest';
import {
  EMPTY_PERSON_FORM,
  newPersonPayload,
  payoutUpdatePayload,
  revealSecondsLeft,
} from './person-forms';

describe('persona nueva', () => {
  const base = { ...EMPTY_PERSON_FORM, venueId: 'v1', email: ' Ana@Luna.ES ' };

  it('encargado: email en minúsculas, sin comisión', () => {
    expect(newPersonPayload({ ...base, role: 'MANAGER', commissionPct: '50' })).toEqual({
      ok: true,
      value: { venueId: 'v1', role: 'MANAGER', email: 'ana@luna.es' },
    });
  });

  it('chica: nombre obligatorio y su % propio', () => {
    expect(newPersonPayload({ ...base, role: 'OPERATOR' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/nombre/),
    });
    expect(newPersonPayload({ ...base, role: 'OPERATOR', displayName: 'Ana', commissionPct: '85' })).toEqual({
      ok: true,
      value: { venueId: 'v1', role: 'OPERATOR', email: 'ana@luna.es', displayName: 'Ana', commissionBps: 8500 },
    });
  });

  it('faltan local, rol o email', () => {
    expect(newPersonPayload({ ...base, venueId: '', role: 'OWNER' })).toMatchObject({ ok: false });
    expect(newPersonPayload({ ...base, role: '' })).toMatchObject({ ok: false });
    expect(newPersonPayload({ ...base, role: 'OWNER', email: 'ana' })).toMatchObject({
      ok: false,
      error: 'El email no es válido.',
    });
  });
});

describe('cuenta de cobro', () => {
  it('sin método: se quita (todo a null)', () => {
    expect(payoutUpdatePayload({ method: null, address: null, metadata: null, label: null })).toEqual({
      ok: true,
      value: { payoutMethod: null, payoutAddress: null, payoutLabel: null, payoutMetadata: null },
    });
  });

  it('se comprueba según el método (como la app de las chicas)', () => {
    expect(
      payoutUpdatePayload({ method: 'USDT_TRC20', address: '0x1234', metadata: null, label: null }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Tron/) });
    expect(
      payoutUpdatePayload({ method: 'SEPA_IBAN', address: 'ES9121000418450200051333', metadata: null, label: null }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/IBAN/) });
    expect(
      payoutUpdatePayload({ method: 'SEPA_IBAN', address: 'ES9121000418450200051332', metadata: null, label: 'Ana' }),
    ).toMatchObject({ ok: false, error: 'Falta el titular de la cuenta' });
    expect(
      payoutUpdatePayload({
        method: 'SEPA_IBAN',
        address: 'ES9121000418450200051332',
        metadata: { accountHolder: 'Ana López' },
        label: 'Ana',
      }),
    ).toEqual({
      ok: true,
      value: {
        payoutMethod: 'SEPA_IBAN',
        payoutAddress: 'ES9121000418450200051332',
        payoutLabel: 'Ana',
        payoutMetadata: { accountHolder: 'Ana López' },
      },
    });
  });

  it('efectivo no tiene cuenta: se explica', () => {
    expect(payoutUpdatePayload({ method: 'MANUAL_CASH', address: null, metadata: null, label: null })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/efectivo/i),
    });
  });

  it('falta la cuenta para el método', () => {
    expect(payoutUpdatePayload({ method: 'PAYONEER_EMAIL', address: null, metadata: null, label: null })).toMatchObject(
      { ok: false, error: expect.stringMatching(/Falta/) },
    );
  });
});

describe('revealSecondsLeft', () => {
  it('cuenta atrás de 30 s y nunca negativa', () => {
    expect(revealSecondsLeft(31_000, 1_000)).toBe(30);
    expect(revealSecondsLeft(31_000, 30_500)).toBe(1);
    expect(revealSecondsLeft(31_000, 40_000)).toBe(0);
  });
});
