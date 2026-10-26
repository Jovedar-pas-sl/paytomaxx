import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ServiceItem } from './api';
import { CARTA_START, cartaArrived, cartaFailed } from './carta-state';

// APP-04: la carta se vuelve a pedir en cada focus / visibilitychange. Un
// refetch que falla con la carta ya a la vista no avisa «No se pudo cargar la
// carta» ni re-renderiza; uno que trae lo mismo, tampoco.

const COPA: ServiceItem = { id: 's-copa', name: 'Copa', durationMin: null, priceCents: 1000, category: 'VENUE_BAR' };
const HORA: ServiceItem = { id: 's-1h', name: '1 h', durationMin: 60, priceCents: 12_000, category: 'CHICA_SERVICE' };

describe('la carta del puesto', () => {
  it('la primera carga: la carta y ya contestó', () => {
    const s = cartaArrived(CARTA_START, [COPA, HORA]);
    expect(s).toEqual({ services: [COPA, HORA], failed: false, loaded: true });
  });

  it('la primera carga falla: se avisa (y se cobra tecleando)', () => {
    expect(cartaFailed(CARTA_START)).toEqual({ services: [], failed: true, loaded: true });
  });

  it('con la carta ya a la vista, un refetch que falla no cambia nada (el mismo estado: sin aviso ni re-render)', () => {
    const shown = cartaArrived(CARTA_START, [COPA]);
    expect(cartaFailed(shown)).toBe(shown);
  });

  it('un refetch con la misma carta (otro array, mismos datos) deja el mismo estado', () => {
    const shown = cartaArrived(CARTA_START, [COPA, HORA]);
    expect(cartaArrived(shown, [{ ...COPA }, { ...HORA }])).toBe(shown);
  });

  it('si cambió (otro precio, uno más), la nueva; y tras un fallo, la carta buena quita el aviso', () => {
    const shown = cartaArrived(CARTA_START, [COPA]);
    const dearer = cartaArrived(shown, [{ ...COPA, priceCents: 1200 }]);
    expect(dearer).not.toBe(shown);
    expect(dearer.services[0]?.priceCents).toBe(1200);
    const failed = cartaFailed(CARTA_START);
    expect(cartaArrived(failed, [COPA])).toEqual({ services: [COPA], failed: false, loaded: true });
  });

  it('dos fallos seguidos sin carta: el mismo estado (sin re-render)', () => {
    const failed = cartaFailed(CARTA_START);
    expect(cartaFailed(failed)).toBe(failed);
  });
});

describe('las pantallas lo usan', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  it('useCarta guarda la carta con cartaArrived / cartaFailed', () => {
    const src = read('../components/carta.tsx');
    expect(src).toMatch(/cartaArrived\(/);
    expect(src).toMatch(/cartaFailed\(/);
  });

  it('el escáner de la chica no se reinicia porque el padre se pinte otra vez (onChica en una ref)', () => {
    const src = read('../components/cobrar/EscanearChica.tsx');
    expect(src).not.toMatch(/\[onChica\]\)/);
    expect(src).toMatch(/onChicaRef\.current\(/);
  });
});
