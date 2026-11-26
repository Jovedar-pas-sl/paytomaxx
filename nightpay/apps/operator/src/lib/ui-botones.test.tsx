import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, ICON_PATHS } from '@nightpay/ui';

// «Piezas II», parte A (idea 54): los botones que faltaban. `quiet` (sin fondo
// ni filete, para lo de poca importancia) y `danger-outline` (borrar o devolver
// dinero desde una fila), y un icono junto al texto. Un botón principal por
// pantalla; en las filas, ninguno.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UI = '../../../../packages/ui/src/';
const ADMIN = '../../../admin/src/components/';
const PIECES2 = read(`${UI}pieces-2.css`);

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const paths = (html: string): string[] => [...html.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!);

describe('Button: las dos variantes nuevas', () => {
  it('`quiet` y `danger-outline` salen como data-variant, con los tamaños de siempre', () => {
    expect(renderToStaticMarkup(<Button variant="quiet">Ver detalle</Button>)).toContain('data-variant="quiet" data-size="md"');
    expect(
      renderToStaticMarkup(
        <Button variant="danger-outline" size="sm">
          Anular cobro
        </Button>,
      ),
    ).toContain('data-variant="danger-outline" data-size="sm"');
  });

  it('`quiet`: sin fondo ni filete, texto normal en 600; con el ratón, un paso de superficie', () => {
    const quiet = rule(PIECES2, ".np-btn[data-variant='quiet']");
    expect(quiet).toContain('background: transparent;');
    expect(quiet).toContain('box-shadow: none;');
    expect(quiet).toContain('color: var(--np-text);');
    // El peso es el de .np-btn (600): aquí no se rebaja.
    expect(quiet).not.toContain('font-weight');
    expect(read(`${UI}styles.css`)).toMatch(/\n\.np-btn \{[^}]*font-weight: 600;/);
    expect(rule(PIECES2, ".np-btn[data-variant='quiet']:hover:not(:disabled)")).toContain('background: var(--np-surface-2);');
  });

  it('`quiet` apagado: solo el texto apagado (gana a la regla general, que le pondría fondo y filete)', () => {
    const off = rule(PIECES2, ".np-btn[data-variant='quiet']:disabled:not([data-loading])");
    expect(off).toContain('color: var(--np-disabled-ink);');
    expect(off).toContain('background: transparent;');
    expect(off).toContain('box-shadow: none;');
    expect(off).not.toMatch(/opacity/);
  });

  it('`danger-outline`: texto en el rojo de los textos y filete de 1 px en el rojo', () => {
    const outline = rule(PIECES2, ".np-btn[data-variant='danger-outline']");
    expect(outline).toContain('color: var(--np-danger-text);');
    expect(outline).toContain('box-shadow: inset 0 0 0 1px var(--np-danger);');
    expect(outline).toContain('background: transparent;');
  });

  it('siguen siendo píldora y con el foco de todos: ninguna regla suya toca el radio ni el contorno', () => {
    const css = PIECES2.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]*\.np-btn[^{}]*)\{([^}]*)\}/g)) expect(m[2], m[1]!.trim()).not.toMatch(/border-radius|outline/);
  });
});

describe('Button: un icono junto al texto', () => {
  it('`icon` delante e `iconEnd` detrás, de 20 px y dentro del <span> del texto', () => {
    const html = renderToStaticMarkup(
      <Button variant="quiet" size="sm" iconEnd="chevron-right">
        Ver detalle
      </Button>,
    );
    expect(html).toMatch(/<span[^>]*>Ver detalle<svg [^>]*width="20" height="20"[^>]*class="np-btn-icon np-btn-icon-end"[^>]*>.*<\/svg><\/span><\/button>$/);
    expect(html).toContain('aria-hidden="true"');
    expect(paths(html)).toEqual([...ICON_PATHS['chevron-right']]);
    const before = renderToStaticMarkup(<Button icon="printer">Imprimir</Button>);
    expect(before).toMatch(/<span[^>]*><svg [^>]*class="np-btn-icon"[^>]*>.*<\/svg>Imprimir<\/span><\/button>$/);
    expect(paths(before)).toEqual([...ICON_PATHS.printer]);
  });

  it('sin icono, el botón de siempre: solo su texto', () => {
    expect(renderToStaticMarkup(<Button>Guardar</Button>)).toMatch(/<span[^>]*>Guardar<\/span><\/button>$/);
  });

  it('8 px de hueco con el texto, sin agrandar la línea', () => {
    expect(rule(PIECES2, '.np-btn-icon')).toContain('margin: -0.25rem 0.5rem -0.25rem 0;');
    expect(rule(PIECES2, '.np-btn-icon-end')).toContain('margin: -0.25rem 0 -0.25rem 0.5rem;');
  });

  it('la flecha a la derecha ya está en el juego de iconos', () => {
    expect(ICON_PATHS['chevron-right']).toEqual(['M9 5l7 7-7 7']);
  });
});

/** Las etiquetas <Button …> de un fichero (enteras: el «>» de una flecha «=>» no las corta), cada una con su variante (sin decirla, sería el principal). */
function buttons(src: string): Array<{ tag: string; variant: string }> {
  return [...src.matchAll(/<Button\b(?:=>|[^>])*>/g)].map((m) => ({ tag: m[0], variant: /variant="([^"]+)"/.exec(m[0])?.[1] ?? 'primary' }));
}

describe('en una fila de Cobros no hay botón principal', () => {
  const actions = buttons(read(`${ADMIN}CobroRowActions.tsx`));
  const of = (handler: string) => actions.find((b) => b.tag.includes(handler))!;

  it('lo que devuelve o anula dinero, en `danger-outline`', () => {
    for (const handler of ['onReverse(row)', 'onRefund(p)', 'onCashRefund?.(p)']) expect(of(handler).variant, handler).toBe('danger-outline');
  });

  it('«Devoluciones» (solo mirar), discreto; «Resolver», secundario', () => {
    expect(of('onRefunds(p)').variant).toBe('quiet');
    expect(of('onResolve(p)').variant).toBe('ghost');
  });

  it('los cinco, pequeños y ninguno principal', () => {
    expect(actions).toHaveLength(5);
    for (const b of actions) {
      expect(b.variant, b.tag).not.toBe('primary');
      expect(b.tag).toContain('size="sm"');
    }
  });

  // Entrega 9 (idea 15): «Ver detalle» ya no existe. La fila entera abre el detalle
  // y los botones del cobro van en su pie: en la tabla no queda ningún botón de acción.
  it('la tabla ya no lleva botones: ni «Ver detalle» ni «Acciones»', () => {
    const table = read(`${ADMIN}fichas/CobrosTable.tsx`);
    expect(buttons(table)).toEqual([]);
    expect(table).not.toContain('Ver detalle');
    expect(table).not.toContain('Acciones');
  });
});
