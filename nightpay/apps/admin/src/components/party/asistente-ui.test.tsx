import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chip, DAY_CSS, DayButton, DayField, Kpi } from './asistente-ui';

// Las piezas de día de Pulseras y Devoluciones: el estado siempre con palabras
// (no solo color), los botones no envían formularios por sorpresa y cada
// campo lleva su etiqueta.

describe('piezas de día de OxioParty', () => {
  it('una cifra con su etiqueta; la destacada, en tinta', () => {
    const html = renderToStaticMarkup(<Kpi label="Donado a la comisión" value="17,00 €" hint="3 asistentes" strong />);
    expect(html).toContain('class="pa-kpi strong"');
    expect(html).toContain('Donado a la comisión');
    expect(html).toContain('3 asistentes');
  });

  it('el estado con palabras (el color solo acompaña)', () => {
    const html = renderToStaticMarkup(<Chip tone="warn">Pendiente</Chip>);
    expect(html).toBe('<span class="pa-chip warn"><i aria-hidden="true"></i>Pendiente</span>');
  });

  it('los botones son de tipo button salvo que se diga', () => {
    expect(renderToStaticMarkup(<DayButton>Bloquear</DayButton>)).toContain('type="button"');
    expect(renderToStaticMarkup(<DayButton type="submit" variant="primary">Buscar</DayButton>)).toContain('type="submit" class="pa-btn primary"');
  });

  it('cada campo con su etiqueta', () => {
    const html = renderToStaticMarkup(<DayField id="pa-q" label="Número" />);
    expect(html).toContain('<label for="pa-q">Número</label>');
    expect(html).toContain('id="pa-q"');
  });

  it('colores de día y foco visible', () => {
    expect(DAY_CSS).toContain('--pa-bg:#F3F1EC');
    expect(DAY_CSS).toContain('.pa-btn.primary{background:var(--pa-ink);border-color:var(--pa-ink);color:var(--pa-lime)}');
    expect(DAY_CSS).toContain(':focus-visible');
  });
});
