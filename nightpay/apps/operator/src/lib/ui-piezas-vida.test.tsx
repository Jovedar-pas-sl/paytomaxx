// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmptyState, RollingNumber, Skeleton } from '@nightpay/ui';

// «Piezas I»: las tres piezas que solo se crean aquí (las aplican las entregas
// 4 en adelante). RollingNumber (la cifra que rueda), EmptyState (dibujo,
// frase, botón) y Skeleton (la silueta de carga, que sube del panel).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UI = '../../../../packages/ui/src/';
const PIECES = read(`${UI}pieces.css`);
const STYLES = read(`${UI}styles.css`);
const NBSP = '\u00a0';

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (el: ReactElement) => act(() => root.render(el));

describe('RollingNumber', () => {
  const cells = () => Array.from(host.querySelectorAll<HTMLElement>('.np-roll-row > span'));
  const cols = () => Array.from(host.querySelectorAll<HTMLElement>('.np-roll-col'));
  const shifts = () => cols().map((c) => c.style.transform);

  it('la primera vez sale tal cual: cada cifra ya en su sitio, sin subir desde cero', () => {
    render(<RollingNumber text={`1.275,00${NBSP}€`} dim={[5, 8]} />);
    expect(shifts()).toEqual(['translateY(-10%)', 'translateY(-20%)', 'translateY(-70%)', 'translateY(-50%)', 'translateY(0%)', 'translateY(0%)']);
    // Cada columna, del 0 al 9.
    expect(cols()[0]!.textContent).toBe('0123456789');
  });

  it('el texto entero es para el lector de pantalla; las columnas no se leen', () => {
    render(<RollingNumber text={`1.275,00${NBSP}€`} dim={[5, 8]} />);
    expect(host.querySelector('.np-sr-only')!.textContent).toBe(`1.275,00${NBSP}€`);
    expect(host.querySelector('.np-roll-row')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('puntos, comas y «€» van quietos (sin columna); el tramo `dim`, apagado', () => {
    render(<RollingNumber text={`1.275,00${NBSP}€`} dim={[5, 8]} />);
    const all = cells();
    expect(all).toHaveLength(10);
    const still = all.filter((c) => !c.querySelector('.np-roll-col'));
    expect(still.map((c) => c.textContent)).toEqual(['.', ',', NBSP, '€']);
    expect(all.map((c) => c.hasAttribute('data-dim'))).toEqual([false, false, false, false, false, true, true, true, false, false]);
  });

  it('al cambiar, las MISMAS columnas se mueven con translateY (así corre la transición)', () => {
    render(<RollingNumber text={`1.275,00${NBSP}€`} />);
    const before = cols();
    render(<RollingNumber text={`1.308,50${NBSP}€`} />);
    expect(cols().every((c, i) => c === before[i])).toBe(true);
    expect(shifts()).toEqual(['translateY(-10%)', 'translateY(-30%)', 'translateY(0%)', 'translateY(-80%)', 'translateY(-50%)', 'translateY(0%)']);
    expect(host.querySelector('.np-sr-only')!.textContent).toBe(`1.308,50${NBSP}€`);
  });

  it('alineada a la derecha: al crecer, las cifras de la derecha siguen siendo las mismas', () => {
    render(<RollingNumber text={`950${NBSP}€`} />);
    const before = cols();
    render(<RollingNumber text={`1.050${NBSP}€`} />);
    expect(cols()).toHaveLength(4);
    expect(cols().slice(-3).every((c, i) => c === before[i])).toBe(true);
    expect(rule(PIECES, '.np-roll')).toContain('text-align: right');
  });

  it('un render por cambio, sin reloj: ni temporizadores ni requestAnimationFrame', () => {
    const frames = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frames);
    render(<RollingNumber text={`10${NBSP}€`} />);
    render(<RollingNumber text={`25${NBSP}€`} />);
    expect(frames).not.toHaveBeenCalled();
    const source = read(`${UI}components/RollingNumber.tsx`);
    expect(source).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|useEffect|useState/);
    vi.unstubAllGlobals();
  });

  it('rueda solo con transform, 700 ms y la curva de la casa; cifras tabulares', () => {
    const col = rule(PIECES, '.np-roll-col');
    expect(col).toContain('transition: transform 700ms var(--np-ease)');
    // En la fila de dentro: así gana también dentro de un importe héroe (proporcional).
    expect(rule(PIECES, '.np-roll-row')).toContain('font-variant-numeric: tabular-nums');
  });

  it('con «reducir movimiento», salta: la regla general deja las transiciones en nada', () => {
    const at = STYLES.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    expect(STYLES.slice(at)).toMatch(/transition-duration: 0\.01ms !important;/);
    expect(rule(PIECES, '.np-roll-col')).not.toContain('!important');
  });
});

describe('EmptyState', () => {
  it('dibujo en su círculo, frase, explicación y UN botón secundario de tamaño md', () => {
    const onClick = vi.fn();
    render(<EmptyState icon="list" title="Aún no has cobrado esta noche" text="Aquí verás cada cobro y cómo se pagó." action={{ label: 'Cobrar ahora', onClick }} />);
    expect(host.querySelector('.np-empty-title')!.textContent).toBe('Aún no has cobrado esta noche');
    expect(host.querySelector('.np-empty-text')!.textContent).toBe('Aquí verás cada cobro y cómo se pagó.');
    expect(host.querySelector('.np-empty-icon svg')!.getAttribute('width')).toBe('28');
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('Cobrar ahora');
    expect(buttons[0]!.dataset.variant).toBe('ghost');
    expect(buttons[0]!.dataset.size).toBe('md');
    act(() => buttons[0]!.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('`primary`: el botón pasa a ser el principal', () => {
    render(<EmptyState icon="list" title="Sin cobros" action={{ label: 'Cobrar ahora', onClick: () => {}, primary: true }} />);
    expect(host.querySelector('button')!.dataset.variant).toBe('primary');
  });

  it('sin acción ni texto, solo el dibujo y la frase', () => {
    render(<EmptyState icon="clock" title="Nada pendiente" />);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.querySelector('.np-empty-text')).toBeNull();
  });

  it('`art`: un dibujo propio en lugar del icono', () => {
    render(<EmptyState art={<img alt="" src="data:," />} title="Sin fichas" />);
    expect(host.querySelector('.np-empty img')).not.toBeNull();
    expect(host.querySelector('.np-empty-icon')).toBeNull();
  });

  it('`compact`: icono de 20 sin círculo y NINGÚN botón, aunque se le pase', () => {
    render(<EmptyState compact icon="list" title="Sin cobros" action={{ label: 'Cobrar ahora', onClick: () => {} }} />);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.querySelector('.np-empty')!.hasAttribute('data-compact')).toBe(true);
    expect(host.querySelector('.np-empty svg')!.getAttribute('width')).toBe('20');
    expect(host.querySelector('.np-empty-icon')).toBeNull();
  });

  it('centrado y de 20rem como mucho; círculo de 72 en --np-surface-2; título 18/600 (16 en compacto)', () => {
    const box = rule(PIECES, '.np-empty');
    expect(box).toContain('max-width: 20rem');
    expect(box).toContain('text-align: center');
    const circle = rule(PIECES, '.np-empty-icon');
    expect(circle).toContain('width: 4.5rem');
    expect(circle).toContain('height: 4.5rem');
    expect(circle).toContain('background: var(--np-surface-2)');
    const title = rule(PIECES, '.np-empty-title');
    expect(title).toContain('font-size: var(--np-fs-18)');
    expect(title).toContain('font-weight: 600');
    expect(rule(PIECES, '.np-empty[data-compact] .np-empty-title')).toContain('font-size: var(--np-fs-16)');
    const text = rule(PIECES, '.np-empty-text');
    expect(text).toContain('font-size: var(--np-fs-16)');
    expect(text).toContain('color: var(--np-text-mute)');
  });
});

describe('Skeleton', () => {
  it('un bloque con la forma de lo que va a llegar, decorativo', () => {
    render(<Skeleton width="9rem" height="2.75rem" />);
    const skel = host.querySelector<HTMLElement>('.np-skel')!;
    expect(skel.getAttribute('aria-hidden')).toBe('true');
    expect(skel.style.width).toBe('9rem');
    expect(skel.style.height).toBe('2.75rem');
    expect(skel.hasAttribute('data-round')).toBe(false);
  });

  it('`round` y, sin medidas, todo el ancho y 1rem de alto', () => {
    render(<Skeleton round />);
    const skel = host.querySelector<HTMLElement>('.np-skel')!;
    expect(skel.hasAttribute('data-round')).toBe(true);
    expect(skel.style.width).toBe('100%');
    expect(skel.style.height).toBe('1rem');
  });

  it('`lines={3}`: tres barras de 1rem, la última al 60 %', () => {
    render(<Skeleton lines={3} />);
    const bars = Array.from(host.querySelectorAll<HTMLElement>('.np-skel'));
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => b.style.height)).toEqual(['1rem', '1rem', '1rem']);
    expect(bars.map((b) => b.style.width)).toEqual(['100%', '100%', '60%']);
  });

  it('respira solo con la opacidad (0,45 ↔ 1, 1,6 s) y sale si la carga pasa de 300 ms', () => {
    const at = PIECES.indexOf('@keyframes np-skel-breathe');
    expect(at).toBeGreaterThan(-1);
    // Hasta el cierre del @keyframes (la primera llave en la columna 0).
    const frames = PIECES.slice(at, PIECES.indexOf('\n}', at));
    expect(frames).toMatch(/opacity: 0\.45;/);
    expect(frames).toMatch(/opacity: 1;/);
    const props = Array.from(frames.matchAll(/^\s+([a-z-]+):/gm)).map((m) => m[1]);
    expect(new Set(props)).toEqual(new Set(['opacity']));
    const skel = rule(PIECES, '.np-skel');
    expect(skel).toContain('animation: np-skel-breathe 1.6s ease-in-out 300ms infinite');
    // Hasta entonces no se ve (pero ocupa su sitio: nada salta al llegar).
    expect(skel).toContain('opacity: 0');
  });

  it('con «reducir movimiento», quieta a 0,7', () => {
    expect(PIECES).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.np-skel \{\s*animation: none;\s*opacity: 0\.7;/);
  });

  it('sube del panel: el panel la reexporta y ya no tiene su .np-skel ni su animación', () => {
    const admin = read('../../../admin/src/components/Skeleton.tsx');
    expect(admin).toMatch(/export \{ Skeleton as Skel \} from '@nightpay\/ui';/);
    expect(admin).toContain('<Skeleton width={WIDTHS[(r + c) % WIDTHS.length]} height="1rem" />');
    const grafito = read('../../../admin/src/styles/panel-grafito.css');
    expect(grafito).not.toMatch(/\.np-skel \{|\.np-skel\[data-round\]/);
  });

  it('un único @keyframes np-breathe, el de staff.css: si lo pisa otro, el QR del cobro parpadea', () => {
    // Con rutas y no con URL: en jsdom, el URL global no es el de Node y readdirSync no lo admite.
    const here = dirname(fileURLToPath(import.meta.url));
    const where: string[] = [];
    for (const dir of [join(here, UI), join(here, '../../../admin/src/styles')]) {
      for (const name of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
        const count = readFileSync(join(dir, name), 'utf8').match(/@keyframes np-breathe\b/g)?.length ?? 0;
        for (let i = 0; i < count; i += 1) where.push(name);
      }
    }
    expect(where).toEqual(['staff.css']);
  });
});
