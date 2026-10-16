import { describe, expect, it } from 'vitest';
import { formatIbanInput, holderProblem, ibanProblem, maskedIban } from './iban';

// IBAN de ejemplo con el dígito de control bien (ISO 13616).
const GOOD_ES = 'ES9121000418450200051332';
const GOOD_DE = 'DE89370400440532013000';

describe('ibanProblem (módulo 97 en el navegador)', () => {
  it('IBAN buenos, con o sin espacios y en minúsculas', () => {
    expect(ibanProblem(GOOD_ES)).toBeNull();
    expect(ibanProblem('es91 2100 0418 4502 0005 1332')).toBeNull();
    expect(ibanProblem(GOOD_DE)).toBeNull();
  });

  it('un dígito cambiado: el control no cuadra', () => {
    expect(ibanProblem('ES9121000418450200051333')).toMatch(/dígito de control/);
  });

  it('largo de España: 24', () => {
    expect(ibanProblem('ES91210004184502000513')).toMatch(/24 caracteres y este tiene 22/);
  });

  it('vacío, signos raros o sin país', () => {
    expect(ibanProblem('')).toMatch(/Pon el IBAN/);
    expect(ibanProblem('ES91-2100-0418')).toMatch(/letras y números/);
    expect(ibanProblem('1234567890')).toMatch(/país/);
  });
});

describe('formatIbanInput', () => {
  it('grupos de 4 en mayúsculas', () => {
    expect(formatIbanInput('es9121000418450200051332')).toBe('ES91 2100 0418 4502 0005 1332');
    expect(formatIbanInput('ES91 21')).toBe('ES91 21');
    expect(formatIbanInput('ES91')).toBe('ES91');
  });

  it('quita lo que no es letra o número y corta en 34', () => {
    expect(formatIbanInput('ES91-2100')).toBe('ES91 2100');
    expect(formatIbanInput('A'.repeat(40)).replace(/ /g, '')).toHaveLength(34);
  });
});

describe('maskedIban', () => {
  it('tapado como en el registro', () => {
    expect(maskedIban(GOOD_ES)).toBe('ES91 •••• •••• 1332');
    expect(maskedIban('es91 2100 0418 4502 0005 1332')).toBe('ES91 •••• •••• 1332');
    expect(maskedIban(null)).toBeNull();
  });
});

describe('holderProblem', () => {
  it('pide un titular de 2 a 160 letras', () => {
    expect(holderProblem(' ')).toMatch(/titular/);
    expect(holderProblem('Luna Ocio SL')).toBeNull();
    expect(holderProblem('x'.repeat(161))).toMatch(/160/);
  });
});
