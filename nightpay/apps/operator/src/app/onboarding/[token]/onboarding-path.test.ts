import { describe, expect, it } from 'vitest';
import { SelfOnboardingSubmitSchema } from '@nightpay/contracts';
import { EMPTY_PAYOUT } from './onboarding-payout';
import { holderWarning, identityDto, identityProblems, pathDto, pathPayout, pathProblem, payoutPaths } from './onboarding-path';

const IBAN = 'ES91 2100 0418 4502 0005 1332';
const NOTHING_SAVED = { method: null, address: null };

describe('alta: nombre legal y fecha de nacimiento', () => {
  it('sin guardar antes, los dos se piden; con la forma de siempre', () => {
    expect(identityProblems({ legalName: '', birthDate: '' }, {})).toEqual({
      legalName: 'Pon tu nombre y apellidos como en tu documento',
      birthDate: 'Pon tu fecha de nacimiento',
    });
    expect(identityProblems({ legalName: 'Ana', birthDate: '2001-02-30' }, {})).toEqual({
      legalName: 'Pon el nombre y los apellidos como en el documento',
      birthDate: 'Pon tu fecha de nacimiento (día, mes y año)',
    });
    expect(identityProblems({ legalName: 'Ana López', birthDate: '2001-02-28' }, {})).toEqual({});
  });

  it('ya guardados: se pueden dejar en blanco (no se cambian)', () => {
    expect(identityProblems({ legalName: ' ', birthDate: '' }, { legalNameMasked: 'A••• L•••', hasBirthDate: true })).toEqual({});
    expect(identityDto({ legalName: ' ', birthDate: '' })).toEqual({});
    expect(identityDto({ legalName: ' Ana  López ', birthDate: '2001-02-28' })).toEqual({ legalName: 'Ana  López', birthDate: '2001-02-28' });
  });
});

describe('alta: los tres caminos para cobrar', () => {
  it('su cuenta y «otra forma» solo si el enlace deja poner la cuenta; la OxioCard, encendida y sin pedir', () => {
    expect(payoutPaths({ canSetPayout: true, oxiocardEnabled: true, oxiocardStatus: 'NO_SOLICITADA' })).toEqual(['IBAN', 'OXIOCARD', 'BASICA', 'OTRA', 'NADA']);
    expect(payoutPaths({ canSetPayout: false, oxiocardEnabled: true, oxiocardStatus: 'SOLICITADA' })).toEqual(['BASICA', 'NADA']);
    expect(payoutPaths({ canSetPayout: true })).toEqual(['IBAN', 'BASICA', 'OTRA', 'NADA']);
  });

  it('su IBAN: con el método puesto, comprobado y con titular; se manda como SEPA', () => {
    const iban = { ...pathPayout('IBAN'), address: IBAN, confirm: IBAN };
    expect(iban.method).toBe('SEPA_IBAN');
    expect(pathProblem('IBAN', iban, NOTHING_SAVED)).toBe('Falta el titular de la cuenta');
    const ok = { ...iban, accountHolder: 'Ana López' };
    expect(pathProblem('IBAN', ok, NOTHING_SAVED)).toBeNull();
    const dto = pathDto('IBAN', ok);
    expect(dto).toMatchObject({ payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES9121000418450200051332', payoutMetadata: { accountHolder: 'Ana López' } });
    expect(SelfOnboardingSubmitSchema.safeParse(dto).success).toBe(true);
  });

  it('OxioCard: se pide al guardar; cuenta básica o «aún no lo sé»: nada de la cuenta', () => {
    expect(pathDto('OXIOCARD', EMPTY_PAYOUT)).toEqual({ oxiocard: true });
    expect(pathDto('BASICA', EMPTY_PAYOUT)).toEqual({});
    expect(pathDto('NADA', EMPTY_PAYOUT)).toEqual({});
    expect(pathDto('OTRA', EMPTY_PAYOUT)).toEqual({});
    expect(pathProblem('BASICA', EMPTY_PAYOUT, NOTHING_SAVED)).toBeNull();
  });

  it('el titular que no coincide con su nombre legal: se le avisa (el dueño tendrá que confirmarlo)', () => {
    expect(holderWarning('Ana López', 'Pedro Gómez')).toMatch(/no coincide con tu nombre legal/);
    expect(holderWarning('Ana María López', 'ANA LOPEZ')).toBeNull();
    expect(holderWarning('', 'Pedro Gómez')).toBeNull();
    expect(holderWarning('Ana López', '')).toBeNull();
  });
});
