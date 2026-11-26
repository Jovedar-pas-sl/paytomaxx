import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Super-admin: la barra de botones pegada abajo (.np-sa-actions[data-sticky])
 * pinta --np-surface liso. Sobre una tarjeta con degradado (desde la entrega 1)
 * se veía una franja más oscura: las tarjetas que la llevan van lisas, con una
 * clase (como .np-table-host y .np-set-card), sin :has().
 */

const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const CSS = strip(read('../styles/panel-superadmin.css'));

describe('super-admin: tarjetas con la barra de botones pegada', () => {
  it('.np-sa-card va lisa, con el borde y la sombra de la tarjeta', () => {
    expect(CSS).toMatch(/\.np-sa-card \{\s*background-image: none;\s*\}/);
    expect(CSS).not.toMatch(/:has\(/);
  });

  it('la barra pegada sigue pintando --np-surface (y --np-surface-2 en una ventana o una tarjeta elevada)', () => {
    expect(CSS).toMatch(/\.np-sa-actions\[data-sticky\] \{[^}]*background: var\(--np-surface\);/);
    expect(CSS).toMatch(/\[data-variant='elevated'\] \.np-sa-actions\[data-sticky\] \{\s*background: var\(--np-surface-2\);/);
  });

  it('la llevan las tarjetas con formulario (.np-sa-form) y barra pegada, y la de la ficha del cliente', () => {
    for (const file of ['VenueDetail', 'BusinessDetail', 'VenueRulesCard']) {
      const src = read(`../components/superadmin/${file}.tsx`);
      expect(src, file).toMatch(/<Card className="np-sa-card">\s*<form className="np-sa-form"/);
    }
    const customer = read('../components/superadmin/CustomerDetail.tsx');
    expect(customer).toMatch(/<Card variant="elevated" className="np-sa-card">[\s\S]*?<StickyActions>/);
  });

  it('ninguna tarjeta con formulario y barra pegada se queda con el degradado', () => {
    for (const file of ['VenueDetail', 'BusinessDetail', 'VenueRulesCard', 'VenuesSection', 'BusinessesSection']) {
      const src = read(`../components/superadmin/${file}.tsx`);
      // Un <Card> sin clase justo antes de un .np-sa-form: le falta .np-sa-card (los formularios en ventana no van en tarjeta).
      expect(src, file).not.toMatch(/<Card>\s*<form className="np-sa-form"/);
    }
  });
});
