import { describe, it, expect } from 'vitest';
import { yavinKeyProblem } from './YavinCard';
import { SA_ACTION_RULES } from '@/lib/superadmin/step-up';

describe('Yavin en super-admin', () => {
  it('la clave se comprueba antes de pedir el código', () => {
    expect(yavinKeyProblem('')).toMatch(/Pega/);
    expect(yavinKeyProblem('con espacio dentro')).toMatch(/espacios/);
    expect(yavinKeyProblem('corta')).toMatch(/más larga/);
    expect(yavinKeyProblem('  clave-inventada-larga  ')).toBeNull();
  });

  it('guardar la clave, usarlo y quitarlo piden 2FA (quitarlo, con motivo)', () => {
    expect(SA_ACTION_RULES['venue.yavinKey']).toEqual({ totp: true, reason: 'none' });
    expect(SA_ACTION_RULES['venue.yavinUse']).toEqual({ totp: true, reason: 'none' });
    expect(SA_ACTION_RULES['venue.yavinClear']).toEqual({ totp: true, reason: 'required' });
  });
});
