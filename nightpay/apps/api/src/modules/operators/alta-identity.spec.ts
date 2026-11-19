import { describe, expect, it } from 'vitest';
import {
  BirthDateSchema,
  LegalNameSchema,
  MINOR_CANNOT_ACTIVATE,
  PAYOUT_HOLDER_UNCONFIRMED,
  SelfOnboardingSubmitSchema,
  UpdateOperatorSchema,
  ageOn,
  isMinor,
  madridToday,
} from '@nightpay/contracts';
import {
  becomesMinor,
  birthDateOf,
  birthDateValue,
  legalNameData,
  legalNameView,
  oxiocardView,
  minorCannotActivate,
  minorLockData,
  minorNow,
  payoutHolderNotConfirmed,
  payoutHolderUnconfirmed,
  sealLegalName,
} from './alta-identity';
import { sealPayoutValue } from './payout-account-crypto';

const KEK = 'clave-de-pruebas-del-alta-0123456789-abcdef';
process.env.ENCRYPTION_KEK ??= KEK;
const kek = process.env.ENCRYPTION_KEK;

describe('edad: 18 años cumplidos el día de su cumpleaños (hora de Madrid)', () => {
  it('cumple los 18 el mismo día, no antes', () => {
    expect(ageOn('2008-11-19', '2026-11-18')).toBe(17);
    expect(ageOn('2008-11-19', '2026-11-19')).toBe(18);
    expect(isMinor('2008-11-19', '2026-11-18')).toBe(true);
    expect(isMinor('2008-11-19', '2026-11-19')).toBe(false);
  });

  it('nacida un 29 de febrero: en un año no bisiesto los cumple el 1 de marzo', () => {
    expect(isMinor('2008-02-29', '2026-02-28')).toBe(true);
    expect(isMinor('2008-02-29', '2026-03-01')).toBe(false);
  });

  it('sin fecha no se sabe: no cuenta como menor', () => {
    expect(isMinor(null, '2026-11-19')).toBe(false);
    expect(isMinor(undefined, '2026-11-19')).toBe(false);
  });

  it('el día es el de Madrid: a las 23:30 UTC del 18 ya es 19 en Madrid', () => {
    expect(madridToday(new Date('2026-11-18T23:30:00Z'))).toBe('2026-11-19');
    expect(madridToday(new Date('2026-07-01T21:59:00Z'))).toBe('2026-07-01');
    expect(madridToday(new Date('2026-07-01T22:00:00Z'))).toBe('2026-07-02');
  });
});

describe('lo que se pide en el alta: fecha de nacimiento y nombre legal', () => {
  it('fecha: un día que existe, desde 1900 y no futura', () => {
    expect(BirthDateSchema.safeParse('1999-05-03').success).toBe(true);
    for (const bad of ['1999-02-30', '03/05/1999', '1899-12-31', '2999-01-01', '', 'ayer']) {
      expect(BirthDateSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('nombre legal: nombre y al menos un apellido, limpio de espacios', () => {
    expect(LegalNameSchema.parse('  María   López Pérez ')).toBe('María López Pérez');
    expect(LegalNameSchema.safeParse('María').success).toBe(false);
    expect(LegalNameSchema.safeParse('Ma\u0000ría López').success).toBe(false);
    expect(LegalNameSchema.safeParse('x'.repeat(60) + ' ' + 'y'.repeat(60)).success).toBe(false);
  });

  it('el alta y el panel los aceptan; el panel, también «la cuenta es suya» y el estado de la OxioCard', () => {
    expect(SelfOnboardingSubmitSchema.safeParse({ legalName: 'Ana López', birthDate: '2000-01-31', oxiocard: true }).success).toBe(true);
    expect(SelfOnboardingSubmitSchema.safeParse({ oxiocard: false }).success).toBe(false);
    const ok = UpdateOperatorSchema.safeParse({ legalName: 'Ana López', birthDate: '2000-01-31', payoutHolderConfirmed: true, oxiocardStatus: 'APROBADA' });
    expect(ok.success).toBe(true);
    expect(UpdateOperatorSchema.safeParse({ oxiocardStatus: 'ENVIADA' }).success).toBe(false);
    expect(UpdateOperatorSchema.safeParse({ payoutHolderConfirmed: false }).success).toBe(false);
  });
});

describe('nombre legal cifrado y fecha de nacimiento en la base', () => {
  it('el nombre se guarda cifrado (pa1:) y solo se abre para esa persona', () => {
    const sealed = sealLegalName('u-1', 'Ana López', kek);
    expect(sealed).toMatch(/^pa1:/);
    expect(sealed).not.toContain('López');
    expect(legalNameView({ id: 'u-1', legalName: sealed }, kek)).toEqual({ plain: 'Ana López', masked: 'A••• L•••' });
    // Copiado a otra persona no se abre: se enseña tapado sin más.
    expect(legalNameView({ id: 'u-2', legalName: sealed }, kek)).toEqual({ plain: null, masked: '••••' });
    expect(legalNameView({ id: 'u-1', legalName: null }, kek)).toEqual({ plain: null, masked: null });
  });

  it('otro nombre: cifrado y la confirmación del titular deja de valer; el mismo de antes, nada', () => {
    const stored = { id: 'u-1', legalName: sealLegalName('u-1', 'Ana López', kek) };
    expect(legalNameData(stored, 'Ana López')).toEqual({});
    const changed = legalNameData(stored, 'Ana López Pérez');
    expect(changed.legalName).toMatch(/^pa1:/);
    expect(changed.payoutHolderConfirmedAt).toBeNull();
  });

  it('su fecha nueva la hace menor (la misma de antes, no: ya se cerró su acceso)', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    expect(becomesMinor(null, '2010-01-01', now)).toBe(true);
    expect(becomesMinor(birthDateValue('2010-01-01'), '2010-01-01', now)).toBe(false);
    expect(becomesMinor(birthDateValue('2010-01-01'), '1990-01-01', now)).toBe(false);
    expect(becomesMinor(null, undefined, now)).toBe(false);
  });

  it('su OxioCard para la app', () => {
    expect(oxiocardView({ oxiocardStatus: 'SOLICITADA', oxiocardStatusAt: new Date('2026-11-19T20:00:00Z') })).toEqual({
      status: 'SOLICITADA',
      at: '2026-11-19T20:00:00.000Z',
    });
    expect(oxiocardView({ oxiocardStatus: 'NO_SOLICITADA', oxiocardStatusAt: null })).toEqual({ status: 'NO_SOLICITADA', at: null });
  });

  it('la fecha va y viene como «AAAA-MM-DD» (columna DATE)', () => {
    expect(birthDateOf(birthDateValue('2001-02-03'))).toBe('2001-02-03');
    expect(birthDateOf(null)).toBeNull();
  });

  it('menor hoy según su fecha guardada', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    expect(minorNow(birthDateValue('2008-11-20'), now)).toBe(true);
    expect(minorNow(birthDateValue('2008-11-19'), now)).toBe(false);
    expect(minorNow(null, now)).toBe(false);
  });
});

describe('menor de edad: no activa la cuenta', () => {
  it('403 con su código, sin decir la fecha', () => {
    const err = minorCannotActivate();
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ code: MINOR_CANNOT_ACTIVATE });
  });

  it('cierra el acceso: otra contraseña que no vale, pendiente de activar, sin invitación y bloqueada', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    const active = minorLockData({ invitedAt: null }, now, 'hash-que-no-vale');
    expect(active).toEqual({
      passwordHash: 'hash-que-no-vale',
      invitedAt: now,
      inviteToken: null,
      onboardingStatus: 'BLOCKED',
    });
    // Pendiente de activar: se mantiene la fecha de la invitación y se anula el enlace.
    const pending = new Date('2026-11-18T10:00:00Z');
    expect(minorLockData({ invitedAt: pending }, now, 'h')).toMatchObject({ invitedAt: pending, inviteToken: null });
  });
});

describe('el titular de su cuenta contra su nombre legal', () => {
  const row = (holder: string | null, legal: string | null, confirmedAt: Date | null = null) => ({
    id: 'u-1',
    displayName: 'Lola',
    payoutMetadata: holder ? { accountHolder: sealPayoutValue(holder, { userId: 'u-1', field: 'holder' }, kek) } : null,
    legalName: legal ? sealLegalName('u-1', legal, kek) : null,
    payoutHolderConfirmedAt: confirmedAt,
  });

  it('coincide, no hay nombre legal o no hay titular: no hay nada que confirmar', () => {
    expect(payoutHolderUnconfirmed(row('Ana López', 'Ana María López Pérez'), kek)).toBe(false);
    expect(payoutHolderUnconfirmed(row('Otra Persona', null), kek)).toBe(false);
    expect(payoutHolderUnconfirmed(row(null, 'Ana López'), kek)).toBe(false);
  });

  it('no coincide: hasta que el dueño lo confirma', () => {
    expect(payoutHolderUnconfirmed(row('Pedro Gómez', 'Ana López'), kek)).toBe(true);
    expect(payoutHolderUnconfirmed(row('Pedro Gómez', 'Ana López', new Date()), kek)).toBe(false);
  });

  it('sin poder abrirlo (otra ENCRYPTION_KEK): que lo confirme el dueño', () => {
    expect(payoutHolderUnconfirmed(row('Ana López', 'Ana López'), 'otra-clave-del-servidor-0123456789-xyz')).toBe(true);
  });

  it('pagar a esa cuenta: 409 con su código; en efectivo, sí', () => {
    const blocked = row('Pedro Gómez', 'Ana López');
    const err = payoutHolderNotConfirmed(blocked, 'SEPA_IBAN', kek);
    expect(err?.getStatus()).toBe(409);
    expect(err?.getResponse()).toMatchObject({ code: PAYOUT_HOLDER_UNCONFIRMED });
    expect(String((err?.getResponse() as { message: string }).message)).toContain('Lola');
    expect(payoutHolderNotConfirmed(blocked, 'MANUAL_CASH', kek)).toBeNull();
    expect(payoutHolderNotConfirmed(row('Ana López', 'Ana López'), 'SEPA_IBAN', kek)).toBeNull();
  });
});
