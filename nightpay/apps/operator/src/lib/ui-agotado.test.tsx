import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ItemTile } from '../components/cobrar/Carta';
import { pickable } from './carta-view';

// Una loseta agotada: lo dice con texto, no se puede añadir y sigue enfocable para quitarlo.

const copa = { id: 'a', name: 'Gin tonic', priceCents: 1200, category: 'VENUE_BAR' };
const noop = () => undefined;
const html = (soldOut: boolean) => renderToStaticMarkup(<ItemTile item={{ ...copa, soldOut }} qty={0} big={false} onPick={noop} onSoldOut={noop} />);

describe('loseta de la carta agotada', () => {
  it('dice «Agotado», se anuncia como agotada y no está desactivada del todo (se puede mantener pulsada)', () => {
    const out = html(true);
    expect(out).toContain('>Agotado<');
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('agotado"');
    expect(out).not.toMatch(/ disabled/);
  });
  it('con el producto disponible no lleva nada de eso', () => {
    const out = html(false);
    expect(out).not.toContain('Agotado');
    expect(out).not.toContain('aria-disabled');
  });
  it('un producto agotado no se puede añadir a la cuenta', () => {
    expect(pickable({ ...copa, soldOut: true })).toBe(false);
    expect(pickable({ ...copa, soldOut: false })).toBe(true);
    expect(pickable(copa)).toBe(true);
  });
});
