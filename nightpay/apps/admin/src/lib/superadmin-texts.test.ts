import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// La consola del super-admin: «Cerrar sesiones» corta al momento lo que la
// persona tenga abierto (AccessRevocationService); antes decía que caducaba
// «en menos de 1 hora», que era como funcionaba antes (prueba real).
const source = readFileSync(new URL('../components/superadmin/PersonActions.tsx', import.meta.url), 'utf8');

describe('textos de «Cerrar sesiones» (super-admin)', () => {
  it('dice que se corta al momento, no «en menos de 1 hora»', () => {
    expect(source).not.toMatch(/menos de 1 hora/);
    expect(source).toMatch(/Cerrar sesiones[\s\S]{0,400}al momento/);
  });
});
