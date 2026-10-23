import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sectionMeta, sectionsOf } from '@nightpay/contracts';
import { PaymentOutcome, sectionsChipText, type PaymentOutcomeProps } from '@nightpay/ui';

// PAGADO / NO PAGADO / CADUCADO: el chip de arriba dice las secciones con el
// nombre que les puso el local (Ajustes → Secciones), como la banda de «Esperando».

// Sin config de vitest propia, packages/ui se compila aquí con JSX clásico (React.createElement).
Object.assign(globalThis, { React });

/** Las de la demo: «Servicios» → «Reservados VIP» y «Comida» → «Cocina». */
const DEMO = sectionsOf({ CHICA_SERVICE: { label: 'Reservados VIP' }, VENUE_FOOD: { label: 'Cocina' } });
const demoLabel = (code: string) => sectionMeta(DEMO, code).label;

function outcome(props: Partial<PaymentOutcomeProps>): string {
  return renderToStaticMarkup(
    React.createElement(PaymentOutcome, {
      kind: 'paid',
      amountCents: 2_100,
      primary: { label: 'Nuevo cobro', onClick: () => undefined },
      ...props,
    }),
  );
}

describe('el texto del chip de secciones', () => {
  it('con los nombres del local', () => {
    expect(sectionsChipText(['VENUE_BAR', 'VENUE_FOOD'], demoLabel)).toBe('Copas + Cocina');
    expect(sectionsChipText(['CHICA_SERVICE'], demoLabel)).toBe('Reservados VIP');
  });

  it('sin nombres del local, los de fábrica; como mucho dos', () => {
    expect(sectionsChipText(['VENUE_BAR', 'VENUE_FOOD'])).toBe('Copas + Comida');
    expect(sectionsChipText(['VENUE_BAR', 'VENUE_FOOD', 'VENUE_ENTRY'], demoLabel)).toBe('Copas + Cocina');
  });
});

describe('la pantalla del resultado', () => {
  it('PAGADO de dos secciones: «Copas + Cocina», no «Comida»', () => {
    const html = outcome({ section: 'VENUE_BAR', sections: ['VENUE_BAR', 'VENUE_FOOD'], sectionLabel: demoLabel });
    expect(html).toContain('Copas + Cocina');
    expect(html).not.toContain('Comida');
  });

  it('una sola sección: su nombre del local (NO PAGADO y CADUCADO, igual)', () => {
    for (const kind of ['paid', 'failed', 'expired'] as const) {
      const html = outcome({ kind, section: 'CHICA_SERVICE', sections: ['CHICA_SERVICE'], sectionLabel: demoLabel });
      expect(html).toContain('Reservados VIP');
      expect(html).not.toContain('>Servicios<');
    }
  });
});
