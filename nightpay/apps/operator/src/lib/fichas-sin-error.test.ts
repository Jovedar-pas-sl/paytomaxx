import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Estudio de fichas, capa A: lo que no es lógica pura sino cómo se cablea en
 * las pantallas (sin cambiar ningún paso).
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('un saldo sin ficha encontrado por su código: «Darle una» (A7)', () => {
  const desk = read('../components/reception/desk/ReceptionDesk.tsx');
  const tab = read('../components/reception/ReceptionTab.tsx');
  const give = read('../components/reception/GiveFicha.tsx');

  it('solo en la entrada, a un saldo sin ficha y sin bloquear', () => {
    const fn = desk.slice(desk.indexOf('function giveFichaOf('), desk.indexOf('function onCode('));
    expect(fn).toContain("mode !== 'entrada'");
    expect(fn).toContain("view?.kind !== 'saldo'");
    expect(fn).toContain('view.fichaNumber !== null');
    expect(fn).toContain('view.blocked');
  });

  it('lleva a «Dar ficha a un saldo» con su código ya escrito, y se busca como siempre (con su QR o su PIN)', () => {
    expect(tab).toMatch(/initialCode=\{fichaCode\}/);
    expect(tab).toMatch(/const giveFicha = methods\.nfc/);
    expect(give).toContain("useState(initialCode ?? '')");
    // Nada se busca solo: el paso de buscar sigue igual.
    expect(give).not.toMatch(/useEffect\([^)]*find\(/);
  });
});
