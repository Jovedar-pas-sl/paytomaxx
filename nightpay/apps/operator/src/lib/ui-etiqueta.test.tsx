import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Etiqueta, ICON_PATHS, SectionChip, StatusPill, Tag, TONE_COLORS, type EtiquetaTone, type IconName } from '@nightpay/ui';

// «Piezas I» (idea 55): UNA etiqueta. De sección: punto del color + nombre
// (es el .np-chip de siempre). De estado: símbolo + palabra sobre su fondo
// teñido; el color nunca va solo. Las del panel (Pill y el chip de sección) y
// el estado del cobro (StatusPill) la pintan sin que cambie quien las usa.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PIECES = read('../../../../packages/ui/src/pieces.css');
const html = renderToStaticMarkup;

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('Etiqueta de sección', () => {
  it('es el .np-chip: misma clase, mismo punto y mismo nombre que SectionChip', () => {
    expect(html(<Etiqueta section="VENUE_BAR" />)).toBe('<span class="np-chip" data-section="copas" style="--np-c:var(--np-sec-copas)">Copas</span>');
    expect(html(<Etiqueta section="VENUE_BAR" />)).toBe(html(<SectionChip section="VENUE_BAR" />));
  });

  it('el saldo, con el punto hueco', () => {
    expect(html(<Etiqueta section="saldo" />)).toContain('data-dashed="true"');
  });

  it('con `label` y `color` no hace falta `section` (el nombre y el color que puso el local)', () => {
    const out = html(<Etiqueta label="Cocina" color="#fd622d" title="Cocina 120 €" />);
    expect(out).toContain('class="np-chip"');
    expect(out).toContain('style="--np-c:#fd622d"');
    expect(out).toContain('title="Cocina 120 €"');
    expect(out).toContain('>Cocina</span>');
  });

  it('`color: null` es «Varias»: el punto a trazos', () => {
    const out = html(<Etiqueta label="Varias" color={null} />);
    expect(out).toContain('class="np-chip"');
    expect(out).toContain('data-mixed="true"');
    expect(out).not.toContain('--np-c');
    const dot = rule(PIECES, ".np-chip[data-mixed='true']::before");
    expect(dot).toContain('background: transparent');
    expect(dot).toMatch(/border: 1\.5px dashed/);
  });

  it('`Tag` es la misma pieza', () => {
    expect(Tag).toBe(Etiqueta);
  });
});

describe('Etiqueta de estado', () => {
  const SYMBOL: Record<Exclude<EtiquetaTone, 'neutral'>, IconName> = {
    success: 'check',
    warning: 'alert',
    danger: 'error',
    info: 'info',
    wait: 'clock',
    refund: 'undo',
  };
  const COLORS: Record<EtiquetaTone, [string, string]> = {
    success: ['var(--np-success)', 'var(--np-pill-success-bg)'],
    warning: ['var(--np-warning)', 'var(--np-pill-warning-bg)'],
    danger: ['var(--np-danger)', 'var(--np-pill-danger-bg)'],
    info: ['var(--np-text)', 'var(--np-pill-mute-bg)'],
    neutral: ['var(--np-text-mute)', 'var(--np-pill-mute-bg)'],
    wait: ['var(--np-text)', 'var(--np-pill-mute-bg)'],
    refund: ['var(--np-purple)', 'var(--np-pill-purple-bg)'],
  };

  for (const [tone, [color, background]] of Object.entries(COLORS) as [EtiquetaTone, [string, string]][]) {
    it(`${tone}: su color de texto sobre su fondo`, () => {
      expect(TONE_COLORS[tone]).toEqual({ color, background });
      const out = html(<Etiqueta tone={tone}>Palabra</Etiqueta>);
      expect(out).toContain('class="np-tag"');
      expect(out).toContain(`data-tone="${tone}"`);
      expect(out).toContain(`color:${color}`);
      expect(out).toContain(`background:${background}`);
      expect(out).toContain('Palabra</span>');
    });
  }

  for (const [tone, icon] of Object.entries(SYMBOL) as [EtiquetaTone, IconName][]) {
    it(`${tone}: lleva su símbolo (${icon}) a 14 px y trazo de 3,4`, () => {
      const out = html(<Etiqueta tone={tone}>Palabra</Etiqueta>);
      expect(out).toContain('width="14" height="14"');
      expect(out).toContain('stroke-width="3.4"');
      expect(out).toContain('aria-hidden="true"');
      expect(out).toContain(`d="${ICON_PATHS[icon][0]}"`);
    });
  }

  it('neutral: un punto de 6 px, sin dibujo', () => {
    const out = html(<Etiqueta tone="neutral">Cancelado</Etiqueta>);
    expect(out).toContain('np-tag-dot');
    expect(out).not.toContain('<svg');
    const dot = rule(PIECES, '.np-tag-dot');
    expect(dot).toContain('width: 6px');
    expect(dot).toContain('height: 6px');
  });

  it('`pulse`: el punto que late en lugar del símbolo', () => {
    const out = html(
      <Etiqueta tone="wait" pulse>
        Esperando pago
      </Etiqueta>,
    );
    expect(out).toContain('np-tag-pulse');
    expect(out).not.toContain('<svg');
    expect(PIECES).toMatch(/\.np-tag-pulse::after \{[^}]*animation: np-pulse-ring 1\.4s ease-out infinite;/);
  });

  it('altos 24 (tablas) y 32 (lo normal en la app táctil); radio 6 y 14/500', () => {
    const base = rule(PIECES, '.np-tag');
    expect(base).toContain('min-height: 1.5rem');
    expect(base).toContain('border-radius: var(--np-r-xs)');
    expect(base).toContain('font-size: var(--np-fs-14)');
    expect(base).toContain('font-weight: 500');
    expect(PIECES).toMatch(/\.np-tag\[data-size='md'\],\s*\.np-touch \.np-tag:not\(\[data-size='sm'\]\) \{\s*min-height: 2rem;/);
    expect(html(<Etiqueta tone="success" size="sm">Pagado</Etiqueta>)).toContain('data-size="sm"');
    expect(html(<Etiqueta tone="success" size="md">Pagado</Etiqueta>)).toContain('data-size="md"');
    expect(html(<Etiqueta tone="success">Pagado</Etiqueta>)).not.toContain('data-size');
  });

  it('acepta className y style; no es un botón', () => {
    const out = html(
      <Etiqueta tone="info" className="mia" style={{ marginLeft: '0.5rem' }}>
        Aviso
      </Etiqueta>,
    );
    expect(out).toMatch(/^<span class="np-tag mia"/);
    expect(out).toContain('margin-left:0.5rem');
    expect(out).not.toMatch(/<button|role="button"|tabindex/);
  });
});

describe('las etiquetas que ya había pintan Etiqueta', () => {
  it('Pill del panel: le pasa el tono y el style; su `dot` ya no hace nada', () => {
    const pill = read('../../../admin/src/components/Pill.tsx');
    expect(pill).toContain('<Etiqueta tone={tone}');
    expect(pill).toContain('style={style}');
    expect(pill).not.toMatch(/dotStyle|pillStyle/);
    // Notice sigue leyendo los colores de aquí.
    expect(pill).toMatch(/export \{[^}]*TONE_COLORS[^}]*\} from '@nightpay\/ui';/);
  });

  it('el chip de sección del panel: punto + nombre, ya no un relleno del color', () => {
    const chip = read('../../../admin/src/components/fichas/SectionChip.tsx');
    expect(chip).toContain('<Etiqueta label={view.label} color={view.color} title={view.title ?? undefined} />');
    expect(chip).not.toMatch(/chipTextColor|background: view\.color/);
  });

  it('StatusPill: mismos textos, role="status" y el latido de «Esperando pago»', () => {
    const waiting = html(<StatusPill status="AUTHORIZING" />);
    expect(waiting).toContain('class="np-tag"');
    expect(waiting).toContain('role="status"');
    expect(waiting).toContain('aria-live="polite"');
    expect(waiting).toContain('data-tone="wait"');
    expect(waiting).toContain('np-tag-pulse');
    expect(waiting).toContain('Esperando pago');
    expect(waiting).toContain('data-size="md"');

    const paid = html(<StatusPill status="AUTHORIZED" size="sm" />);
    expect(paid).toContain('data-tone="success"');
    expect(paid).toContain('data-size="sm"');
    expect(paid).toContain('Pago completado');
    expect(paid).toContain(`d="${ICON_PATHS.check[0]}"`);

    expect(html(<StatusPill status="FAILED" />)).toContain('Pago rechazado');
    expect(html(<StatusPill status="FAILED" />)).toContain('data-tone="danger"');
    expect(html(<StatusPill status="EXPIRED" />)).toContain('data-tone="warning"');
    expect(html(<StatusPill status="CANCELED" />)).toContain('data-tone="neutral"');
    expect(html(<StatusPill status="REFUNDED" />)).toContain('data-tone="refund"');
    expect(html(<StatusPill status="PARTIALLY_REFUNDED" />)).toContain('Reembolso parcial');
    // «Sin confirmar» no late: no se resuelve solo.
    expect(html(<StatusPill status="ORPHAN" />)).not.toContain('np-tag-pulse');
  });

  it('StatusPill visto por el cliente: sus textos, y late mientras espera', () => {
    expect(html(<StatusPill status="AUTHORIZED" perspective="client" />)).toContain('¡Pagado! Gracias');
    const bank = html(<StatusPill status="ORPHAN" perspective="client" />);
    expect(bank).toContain('Verificando con el banco…');
    expect(bank).toContain('data-tone="warning"');
    expect(bank).toContain('np-tag-pulse');
    expect(html(<StatusPill status={'NUEVO' as never} />)).toContain('NUEVO');
  });

  it('el SectionChip de ui no cambia (PAGADO conserva su velo y su chip de dos secciones)', () => {
    expect(html(<SectionChip section="CHICA_SERVICE" />)).toBe(
      '<span class="np-chip" data-section="servicios" style="--np-c:var(--np-sec-servicios)">Servicios</span>',
    );
    expect(html(<SectionChip section="VENUE_BAR">Copas + Cocina</SectionChip>)).toContain('>Copas + Cocina</span>');
    expect(read('../../../../packages/ui/src/components/SectionChip.tsx')).not.toContain('Etiqueta');
  });
});
