import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon, IconButton, ICON_PATHS, type IconName } from '@nightpay/ui';

// «Piezas I» (idea 58, la pieza): UN juego de iconos (rejilla de 24, a trazo,
// puntas redondas, del color del texto) en tres tamaños, siempre con 2 px a la
// vista, y UN botón de solo icono que no puede existir sin su nombre. Migrar
// los iconos de las apps a esta pieza es la parte B.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PIECES = read('../../../../packages/ui/src/pieces.css');
const NAMES = Object.keys(ICON_PATHS) as IconName[];

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('Icon', () => {
  it('los nombres, solo los que se usan (los de la parte A y los que salen de migrar, parte B)', () => {
    expect([...NAMES].sort()).toEqual([
      'activity',
      'alert',
      'backspace',
      'bell',
      'bell-off',
      'card',
      'cash',
      'chart',
      'check',
      'checklist',
      'chevron-left',
      'chevron-right',
      'clock',
      'close',
      'cloud-download',
      'concierge-bell',
      'dots',
      'drink',
      'error',
      'flash',
      'food',
      'hand',
      'home',
      'hourglass',
      'info',
      'list',
      'lock',
      'minus',
      'moon',
      'nfc',
      'plus',
      'pos',
      'printer',
      'qr',
      'share',
      'sliders',
      'store',
      'sun',
      'tag',
      'ticket',
      'undo',
      'users',
      'wallet',
      'wifi-off',
      'wristband',
    ]);
  });

  it('la línea de puntos del ticket, en tres trazos cortos (sin strokeDasharray)', () => {
    const dashes = ICON_PATHS.ticket.filter((d) => /^M14 [\d.]+v\.5$/.test(d));
    expect(dashes).toHaveLength(3);
  });

  for (const name of NAMES) {
    it(`${name}: decorativo, a trazo y con su grosor en los tres tamaños`, () => {
      const html = renderToStaticMarkup(<Icon name={name} />);
      expect(html).toMatch(/^<svg /);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('width="24" height="24"');
      expect(html).toContain('fill="none"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-linecap="round"');
      expect(html).toContain('stroke-linejoin="round"');
      expect(html).toContain('stroke-width="2"');
      // Solo trazos: los círculos y los puntos también son <path>.
      expect(html).not.toMatch(/<circle|<rect|<line|<polyline/);
      expect(html.match(/<path /g)).toHaveLength(ICON_PATHS[name].length);
      for (const size of [20, 24, 28] as const) {
        const sized = renderToStaticMarkup(<Icon name={name} size={size} />);
        expect(sized).toContain(`width="${size}" height="${size}"`);
        const width = Number(/stroke-width="([\d.]+)"/.exec(sized)![1]);
        // 48 / tamaño: 2 px a la vista se pinte al tamaño que se pinte.
        expect((width * size) / 24).toBeCloseTo(2, 5);
      }
    });
  }

  it('acepta una clase (el color y el sitio los pone quien lo usa)', () => {
    expect(renderToStaticMarkup(<Icon name="check" size={20} className="mio" />)).toContain('class="mio"');
  });

  it('los trazos son los que ya había: el ✓ de PAGADO, la lista de la barra, el «!» de FormError', () => {
    expect(ICON_PATHS.check).toEqual(['M5 12.5l4.5 4.5L19 7.5']);
    expect(ICON_PATHS.list).toEqual(['M8 6h13', 'M8 12h13', 'M8 18h13', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01']);
    expect(ICON_PATHS.alert).toEqual(expect.arrayContaining(['M12 7.5v5.5', 'M12 16.5h.01']));
    expect(ICON_PATHS.undo).toEqual(['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11']);
  });
});

describe('IconButton', () => {
  it('su nombre va en aria-label y en title, y es un botón que no envía formularios', () => {
    const html = renderToStaticMarkup(<IconButton icon="close" label="Cerrar" />);
    expect(html).toMatch(/^<button /);
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Cerrar"');
    expect(html).toContain('title="Cerrar"');
    expect(html).toContain('class="np-iconbtn"');
    expect(html).toContain('<svg ');
    expect(html).toContain('aria-hidden="true"');
  });

  it('discreto si no se dice otra cosa; `ghost`, como el botón secundario', () => {
    expect(renderToStaticMarkup(<IconButton icon="close" label="Cerrar" />)).toContain('data-variant="quiet"');
    expect(renderToStaticMarkup(<IconButton icon="undo" label="Deshacer" variant="ghost" />)).toContain('data-variant="ghost"');
    const quiet = rule(PIECES, '.np-iconbtn');
    expect(quiet).toContain('background: transparent');
    expect(quiet).toContain('color: var(--np-text-mute)');
    expect(quiet).toMatch(/border: (none|0)/);
    // Con el ratón encima: un paso de superficie y el texto entero.
    const hover = rule(PIECES, '.np-iconbtn:hover:not(:disabled)');
    expect(hover).toContain('background: var(--np-surface-2)');
    expect(hover).toContain('color: var(--np-text)');
    const ghost = rule(PIECES, ".np-iconbtn[data-variant='ghost']");
    expect(ghost).toContain('background: var(--np-surface-2)');
    expect(ghost).toContain('box-shadow: inset 0 0 0 1px var(--np-border-hi), var(--np-hi)');
  });

  it('redondo y de 44 px; 40 solo con ratón en el panel ancho', () => {
    const base = rule(PIECES, '.np-iconbtn');
    expect(base).toContain('width: 2.75rem');
    expect(base).toContain('height: 2.75rem');
    expect(base).toContain('border-radius: var(--np-r-pill)');
    const at = PIECES.indexOf('@media (min-width: 48em) and (hover: hover) and (pointer: fine)');
    expect(at).toBeGreaterThan(-1);
    const fine = rule(PIECES.slice(at), 'html:not(.np-touch) .np-iconbtn');
    expect(fine).toContain('width: 2.5rem');
    expect(fine).toContain('height: 2.5rem');
  });

  it('apagado: neutro, sin opacidad', () => {
    expect(renderToStaticMarkup(<IconButton icon="close" label="Cerrar" disabled />)).toContain('disabled=""');
    const off = rule(PIECES, '.np-iconbtn:disabled');
    expect(off).toContain('background: var(--np-disabled-bg)');
    expect(off).toContain('color: var(--np-disabled-ink)');
    expect(off).toContain('var(--np-disabled-edge)');
    expect(off).toContain('cursor: not-allowed');
    expect(off).not.toContain('opacity');
  });
});
