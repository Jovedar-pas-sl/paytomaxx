// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, useRef, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, menuPosition, Modal, Sheet, sheetDragEnd } from '@nightpay/ui';
import { resetSheetHistory } from '../../../../packages/ui/src/lib/sheet';

// «Piezas II», parte A (idea 50): la hoja. Hasta 640 px sube desde abajo; desde
// 641 es una ventana, un panel a la derecha o un menú bajo su botón. Se cierra
// con la ✕, Esc, «atrás» y arrastrando (el velo, no), y siempre decide quien la
// usa. Modal es ya una hoja: sus 46 usos no se tocan.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UI = '../../../../packages/ui/src/';
const STYLES = read(`${UI}styles.css`);
const PIECES2 = read(`${UI}pieces-2.css`);
const code = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

/** El CSS sin sus bloques @supports (lo que ve un navegador que no entiende lo que preguntan). */
function withoutSupports(css: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const at = css.indexOf('@supports', i);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, at);
    let depth = 0;
    let j = css.indexOf('{', at);
    do {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    } while (depth > 0);
    i = j;
  }
}

/** El bloque de pantallas anchas (desde 641 px). */
const WIDE = PIECES2.slice(PIECES2.indexOf('@media (min-width: 641px) {'));

describe('el marcado de la hoja', () => {
  const html = renderToStaticMarkup(
    <Sheet open onClose={() => undefined} title="Más filtros" footer={<Button size="lg">Ver 34 cobros</Button>}>
      <p>Las opciones</p>
    </Sheet>,
  );

  it('es una ventana modal con su título; el panel conserva la clase np-modal-panel (la mira el cierre de la noche y el CSS del panel)', () => {
    expect(html).toMatch(/^<div class="np-hoja-velo" data-wide="dialog">/);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('class="np-hoja np-modal-panel"');
    expect(html).toContain('tabindex="-1"');
    const title = /<h3 id="([^"]+)" class="np-hoja-titulo">Más filtros<\/h3>/.exec(html);
    expect(title).not.toBeNull();
    expect(html).toContain(`aria-labelledby="${title![1]}"`);
  });

  it('arriba, el asa (decorativa) y la ✕ «Cerrar», que es el IconButton común', () => {
    expect(html).toContain('<span class="np-hoja-asa" aria-hidden="true"></span>');
    expect(html).toMatch(/<button type="button" aria-label="Cerrar" title="Cerrar" data-variant="quiet" class="np-iconbtn np-hoja-cerrar">/);
    // El asa y la cabecera van juntas: de ahí se arrastra.
    expect(html).toMatch(/<div class="np-hoja-head"><span class="np-hoja-asa"[^>]*><\/span><div class="np-hoja-cabecera">/);
  });

  it('el cuerpo y, aparte, el pie fijo (data-np-foot: el aviso flotante se pone encima)', () => {
    expect(html).toContain('<div class="np-hoja-body"><p>Las opciones</p></div>');
    expect(html).toMatch(/<div class="np-hoja-pie" data-np-foot=""><button[^>]*data-size="lg"/);
  });

  it('cerrada no pinta nada; sin pie, no hay pie', () => {
    expect(renderToStaticMarkup(<Sheet open={false} onClose={() => undefined} title="Más filtros">x</Sheet>)).toBe('');
    expect(renderToStaticMarkup(<Sheet open onClose={() => undefined} title="Más filtros">x</Sheet>)).not.toContain('np-hoja-pie');
  });

  it('`wide`, `width`, `full`, `role` y `describedBy`', () => {
    const side = renderToStaticMarkup(
      <Sheet open onClose={() => undefined} title="Ficha" wide="side" width="30rem" full role="alertdialog" describedBy="por-que">
        x
      </Sheet>,
    );
    expect(side).toContain('data-wide="side"');
    expect(side).toContain('style="--np-hoja-w:30rem"');
    expect(side).toContain('data-full=""');
    expect(side).toContain('role="alertdialog"');
    expect(side).toContain('aria-describedby="por-que"');
    // Sin ancho propio, el de su forma (28, 27.5 y 20rem): lo pone el CSS.
    expect(html).not.toContain('--np-hoja-w');
  });
});

describe('Modal es ya una hoja', () => {
  it('pinta np-hoja con su título y su ancho', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => undefined} title="Menú" width="32rem">
        <p>dentro</p>
      </Modal>,
    );
    expect(html).toContain('class="np-hoja np-modal-panel"');
    expect(html).toContain('class="np-hoja-titulo">Menú</h3>');
    expect(html).toContain('style="--np-hoja-w:32rem"');
    expect(html).toContain('<div class="np-hoja-body"><p>dentro</p></div>');
  });

  it('sin título (los que se pintan cerrados): ni título vacío ni nombre que apunte a nada', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => undefined}>
        x
      </Modal>,
    );
    expect(html).not.toContain('<h3');
    expect(html).not.toContain('aria-labelledby');
    expect(renderToStaticMarkup(<Modal open={false} onClose={() => undefined}>{null}</Modal>)).toBe('');
  });

  it('Modal.tsx solo envuelve a Sheet: el foco, Esc y la pila viven en la hoja', () => {
    const modal = read(`${UI}components/Modal.tsx`);
    expect(modal).toContain("<Sheet open={open} onClose={onClose} title={title ?? ''} width={width}>");
    expect(modal).not.toMatch(/trapFocus|openModals|CSSProperties/);
    const sheet = read(`${UI}components/Sheet.tsx`);
    for (const name of ['function trapFocus(', 'function cycleTab(', 'let openModals']) expect(sheet, name).toContain(name);
    // Sin portal: la hoja se pinta donde se usa.
    expect(sheet).not.toContain('createPortal');
  });

  it('los que usaban una ventana sin título ya lo llevan o se quedan cerrados', () => {
    const profile = read('../../../admin/src/components/MyProfileButton.tsx');
    expect(profile).toContain('<Modal open={open} onClose={() => setOpen(false)} title="Mi perfil" width="36rem">');
    expect(profile).toMatch(/title="Mi perfil" width="36rem">\s*<ScreenHelp \{\.\.\.TOURS\.perfil\} \/>\s*<ProfileScreen\s+bare/);
    expect(profile).not.toContain('help={');
    const payments = read('../../../admin/src/components/PaymentModals.tsx');
    expect(payments).toMatch(/if \(!payment\) \{\s*return <Modal open=\{false\} onClose=\{onClose\}>\{null\}<\/Modal>;/);
    expect(payments).not.toContain('<Modal open={open} onClose={onClose}>{null}</Modal>');
  });
});

describe('pieces-2.css', () => {
  it('se importa detrás de pieces.css', () => {
    expect(STYLES).toMatch(/@import '\.\/pieces\.css';\n@import '\.\/pieces-2\.css';/);
  });

  it('lo ve bien un Chrome 64: sin inset:, gap:, :has(), min() ni clamp(); color-mix() y oklch(), solo dentro de @supports', () => {
    const css = code(PIECES2);
    expect(css).not.toMatch(/(?:^|[\s;{])inset\s*:/);
    expect(css).not.toMatch(/gap\s*:/);
    expect(css).not.toContain(':has(');
    const old = withoutSupports(css);
    expect(old).not.toMatch(/color-mix\(|oklch\(/);
    expect(old).not.toMatch(/[\s:(,](?:min|max|clamp)\(/);
  });

  it('vh antes de dvh; transparencias con comas', () => {
    const css = code(PIECES2);
    for (const m of css.matchAll(/([a-z-]+):\s*([\d.]+)dvh;/g)) {
      const value = m[2]!.replace('.', '\\.');
      expect(css, m[0]).toMatch(new RegExp(`${m[1]}:\\s*${value}vh;\\s*${m[1]}:\\s*${value}dvh;`));
    }
    // …y nunca dentro de un calc(): ahí no habría forma de darle respaldo en la misma línea.
    expect(css.match(/dvh/g)).toHaveLength([...css.matchAll(/([a-z-]+):\s*([\d.]+)dvh;/g)].length);
    expect(css).not.toMatch(/rgba?\(\s*\d+\s+\d+\s+\d+/);
  });

  it('env() (la zona segura), solo APARTE, dentro de @supports: nunca dentro de var() ni como segunda declaración de la regla', () => {
    const css = code(PIECES2);
    // Al compilar, el minificador funde `padding: …; padding-bottom: 16px; padding-bottom: calc(16px + env(…))` en
    // un solo `padding` con env(): un Chrome 64 lo tira entero y el pie se queda sin relleno. Dentro de @supports no
    // se puede fundir con la regla de fuera, y el navegador viejo se queda con ella.
    expect(withoutSupports(css)).not.toContain('env(');
    expect(css).not.toMatch(/var\([^)]*env\(/);
    const blocks = [...css.matchAll(/@supports \(([^)]*\([^)]*\))\) \{/g)].map((m) => m[1]);
    expect(blocks.filter((b) => b!.includes('env('))).toEqual(['padding-bottom: env(safe-area-inset-bottom)', 'padding-bottom: env(safe-area-inset-bottom)']);
    expect(css.match(/env\(safe-area-inset-(?:bottom|top)\)/g)).toHaveLength(2 + 4);
  });

  it('ninguna regla repite una propiedad (el minificador se queda con la última), salvo los altos en vh y dvh', () => {
    const repeated: string[] = [];
    for (const m of code(PIECES2).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const seen = new Set<string>();
      for (const d of m[2]!.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)) {
        const prop = d[1]!;
        if (seen.has(prop) && !/^(?:max-|min-)?height$/.test(prop)) repeated.push(`${m[1]!.trim()} → ${prop}`);
        seen.add(prop);
      }
    }
    expect(repeated).toEqual([]);
  });

  it('las capas: la hoja 100, el menú 110 y el aviso flotante 130', () => {
    const root = STYLES.slice(STYLES.indexOf(':root {'), STYLES.indexOf('\n}', STYLES.indexOf(':root {')));
    expect(root).toContain('--np-z-sheet: 100;');
    expect(root).toContain('--np-z-menu: 110;');
    expect(root).toContain('--np-z-toast: 130;');
    expect(rule(PIECES2, '.np-hoja-velo')).toContain('z-index: var(--np-z-sheet);');
    expect(rule(PIECES2, '.np-toast-region')).toContain('z-index: var(--np-z-toast);');
  });

  it('el velo: un negro con comas y, donde hay variables, el de cada tema; sin desenfoque', () => {
    expect(rule(PIECES2, '.np-hoja-velo')).toContain('background: rgba(5, 6, 7, 0.74);');
    expect(PIECES2).toMatch(/@supports \(--np: 0\) \{\s*\.np-hoja-velo \{\s*background: var\(--np-backdrop\);\s*\}\s*\}/);
    expect(code(PIECES2)).not.toMatch(/backdrop-filter/);
  });

  it('hasta 640 px: abajo y a lo ancho, esquinas de arriba 24, superficie elevada y la sombra de lo que flota; 90 % del alto como mucho', () => {
    const velo = rule(PIECES2, '.np-hoja-velo');
    expect(velo).toContain('align-items: flex-end;');
    for (const side of ['top', 'right', 'bottom', 'left']) expect(velo).toContain(`${side}: 0;`);
    const hoja = rule(PIECES2, '.np-hoja');
    expect(hoja).toContain('width: 100%;');
    expect(hoja).toContain('border-radius: 24px 24px 0 0;');
    expect(hoja).toContain('background: var(--np-surface-2);');
    expect(hoja).toContain('box-shadow: var(--np-shadow-2);');
    expect(hoja).toMatch(/max-height: 90vh;\s*max-height: 90dvh;/);
  });

  it('sube en 250 ms y sin `forwards`: al acabar, el arrastre la mueve con su transform', () => {
    const hoja = rule(PIECES2, '.np-hoja');
    expect(hoja).toContain('animation: np-hoja-in 250ms var(--np-ease);');
    expect(code(PIECES2)).not.toMatch(/forwards|animation-fill-mode/);
    expect(PIECES2).toMatch(/@keyframes np-hoja-in \{\s*from \{\s*transform: translateY\(100%\);/);
  });

  it('`full`: la pantalla entera y sin esquinas, solo en el móvil', () => {
    expect(PIECES2).toMatch(
      /@media \(max-width: 640px\) \{\s*\.np-hoja\[data-full\] \{\s*height: 100vh;\s*height: 100dvh;\s*max-height: 100vh;\s*max-height: 100dvh;\s*border-radius: 0;/,
    );
  });

  it('el asa: 36 × 4 en el filete fuerte; el título, 18/600', () => {
    const asa = rule(PIECES2, '.np-hoja-asa');
    expect(asa).toContain('width: 36px;');
    expect(asa).toContain('height: 4px;');
    expect(asa).toContain('background: var(--np-border-hi);');
    const title = rule(PIECES2, '.np-hoja-titulo');
    expect(title).toContain('font-size: var(--np-fs-18);');
    expect(title).toContain('font-weight: 600;');
  });

  it('solo el asa y la cabecera quitan el gesto del navegador (el cuerpo se sigue desplazando)', () => {
    expect(rule(PIECES2, '.np-hoja-head')).toContain('touch-action: none;');
    expect(code(PIECES2).match(/touch-action: none;/g)).toHaveLength(1);
    const body = rule(PIECES2, '.np-hoja-body');
    expect(body).toContain('overflow-y: auto;');
    expect(body).toContain('padding: 1rem;');
  });

  it('el pie: botones lado a lado; abajo 16 px y, aparte, con la zona segura del móvil', () => {
    const pie = rule(PIECES2, '.np-hoja-pie');
    expect(pie).toContain('display: flex;');
    expect(pie).toContain('padding: 0.75rem 1rem 16px;');
    const safe = PIECES2.slice(PIECES2.indexOf('@supports (padding-bottom: env(safe-area-inset-bottom)) {'));
    expect(rule(safe, '.np-hoja-pie')).toContain('padding-bottom: calc(16px + env(safe-area-inset-bottom));');
    // Sin pie, el final del cuerpo; y la cabecera de una hoja a pantalla entera, bajo la muesca.
    expect(rule(safe, '.np-hoja-body:last-child')).toContain('padding-bottom: calc(1rem + env(safe-area-inset-bottom));');
    expect(rule(safe, '.np-hoja[data-full] > .np-hoja-head')).toContain('padding-top: calc(0.5rem + env(safe-area-inset-top));');
    // En pantalla ancha manda su relleno (va después).
    expect(PIECES2.indexOf('@media (min-width: 641px) {')).toBeGreaterThan(PIECES2.indexOf('@supports (padding-bottom: env(safe-area-inset-bottom)) {'));
    expect(rule(PIECES2, '.np-hoja-pie > *')).toContain('flex: 1 1 0%;');
  });

  it('desde 641 px: centrada, con 24 de relleno, sin asa y la ✕ de 40', () => {
    expect(rule(WIDE, '.np-hoja-velo')).toContain('align-items: center;');
    const hoja = rule(WIDE, '.np-hoja');
    expect(hoja).toContain('width: var(--np-hoja-w, 28rem);');
    expect(hoja).toContain('max-width: calc(100vw - 2rem);');
    expect(hoja).toContain('max-height: 85vh;');
    expect(rule(WIDE, '.np-hoja-asa')).toContain('display: none;');
    expect(rule(WIDE, '.np-hoja-head')).toContain('padding: 1.5rem 1.5rem 0;');
    expect(rule(WIDE, '.np-hoja-head')).toContain('touch-action: auto;');
    expect(rule(WIDE, '.np-hoja-body')).toContain('1.5rem');
    const close = rule(WIDE, '.np-hoja-cerrar');
    expect(close).toContain('width: 2.5rem;');
    expect(close).toContain('height: 2.5rem;');
  });

  it('`side`: a la derecha y de arriba abajo (27.5rem); `menu`: 20rem, un paso más claro, radio 16 y sin velo', () => {
    expect(rule(WIDE, ".np-hoja-velo[data-wide='side']")).toContain('justify-content: flex-end;');
    const side = rule(WIDE, ".np-hoja-velo[data-wide='side'] > .np-hoja");
    expect(side).toContain('width: var(--np-hoja-w, 27.5rem);');
    expect(side).toMatch(/height: 100vh;\s*height: 100dvh;/);
    expect(rule(WIDE, ".np-hoja-velo[data-wide='menu'] > .np-hoja")).toContain('width: var(--np-hoja-w, 20rem);');
    expect(rule(WIDE, '.np-hoja-velo[data-floating]')).toContain('background: transparent;');
    expect(rule(WIDE, '.np-hoja-velo[data-floating]')).toContain('z-index: var(--np-z-menu);');
    const menu = rule(WIDE, '.np-hoja-velo[data-floating] > .np-hoja');
    expect(menu).toContain('position: fixed;');
    expect(menu).toContain('background: var(--np-surface-3);');
    expect(menu).toContain('border-radius: 16px;');
  });

  it('las reglas de alto de .np-modal-panel se van (el alto es de la hoja); .np-modal-close sigue para el cierre de la noche', () => {
    expect(code(STYLES)).not.toMatch(/\.np-modal-panel \{/);
    expect(code(read('../../../admin/src/styles/panel-nav.css'))).not.toMatch(/\.np-modal-panel \{/);
    expect(rule(STYLES, '.np-modal-close')).toContain('width: 2.75rem;');
    // El panel sigue subiendo <main> por encima de su barra de abajo cuando hay una ventana.
    expect(read('../../../admin/src/styles/panel-nav.css')).toContain('.np-app-root:has(.np-modal-panel),');
    expect(read('../../../admin/src/components/NightCloseScreen.tsx')).toContain("document.querySelector('.np-modal-panel')");
  });
});

describe('sheetDragEnd: ¿el arrastre pide cerrar?', () => {
  it('si baja más de un cuarto del alto', () => {
    expect(sheetDragEnd(151, 2000, 600)).toBe(true);
    expect(sheetDragEnd(150, 2000, 600)).toBe(false);
  });

  it('o si es un tirón: 24 px o más a 0,5 px/ms o más', () => {
    expect(sheetDragEnd(24, 48, 600)).toBe(true);
    expect(sheetDragEnd(60, 100, 600)).toBe(true);
    // Corto, aunque rápido; o largo, pero lento y sin llegar al cuarto.
    expect(sheetDragEnd(23, 10, 600)).toBe(false);
    expect(sheetDragEnd(100, 400, 600)).toBe(false);
  });

  it('hacia arriba o sin moverse, nunca', () => {
    expect(sheetDragEnd(0, 0, 600)).toBe(false);
    expect(sheetDragEnd(-200, 50, 600)).toBe(false);
  });
});

describe('menuPosition: dónde va el menú', () => {
  const screen = { width: 1440, height: 900 };
  const panel = { width: 320, height: 240 };

  it('debajo de su botón, a 8 px, alineado por la izquierda', () => {
    expect(menuPosition({ top: 100, bottom: 140, left: 400, right: 520 }, panel, screen)).toEqual({ top: 148, left: 400 });
  });

  it('si debajo no cabe, encima', () => {
    expect(menuPosition({ top: 700, bottom: 740, left: 400, right: 520 }, panel, screen)).toEqual({ top: 452, left: 400 });
  });

  it('nunca a menos de 8 px del borde', () => {
    // El botón, pegado a la derecha: el menú se corre hacia dentro.
    expect(menuPosition({ top: 100, bottom: 140, left: 1380, right: 1430 }, panel, screen)).toEqual({ top: 148, left: 1112 });
    // …o pegado a la izquierda.
    expect(menuPosition({ top: 100, bottom: 140, left: 2, right: 40 }, panel, screen).left).toBe(8);
    // No cabe ni debajo ni encima: arriba del todo, a 8.
    expect(menuPosition({ top: 120, bottom: 160, left: 400, right: 520 }, { width: 320, height: 880 }, screen).top).toBe(8);
  });
});

/** Un historial de mentira bajo window.history: se ve cada entrada y «atrás» lo decide la prueba. */
function fakeHistory() {
  let entries: unknown[] = [{ __NA: true }];
  let index = 0;
  let asked = 0;
  const push = vi.spyOn(window.history, 'pushState').mockImplementation((state: unknown) => {
    entries = [...entries.slice(0, index + 1), state];
    index += 1;
  });
  const replace = vi.spyOn(window.history, 'replaceState').mockImplementation((state: unknown) => {
    entries[index] = state;
  });
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {
    asked += 1;
  });
  vi.spyOn(window.history, 'state', 'get').mockImplementation(() => entries[index]);
  vi.spyOn(window.history, 'length', 'get').mockImplementation(() => entries.length);
  const pop = (): void => {
    index -= 1;
    window.dispatchEvent(new PopStateEvent('popstate', { state: entries[index] }));
  };
  return {
    push,
    replace,
    back,
    entries: () => entries.slice(0, index + 1),
    /** Otro código (las pestañas de la app) añade su entrada. */
    foreign: (state: unknown) => window.history.pushState(state, ''),
    /** El usuario pulsa «atrás». */
    userBack: () => act(() => pop()),
    /** Llegan los `back()` que pidió la hoja (también los que pida al llegar). */
    arrive: () =>
      act(() => {
        while (asked > 0) {
          asked -= 1;
          pop();
        }
      }),
  };
}

let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof fakeHistory>;
beforeEach(() => {
  resetSheetHistory();
  history = fakeHistory();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (el: ReactElement) => act(async () => root.render(el));
/** Deja correr lo que la hoja aplaza un instante (mira el historial después de los efectos). */
const settle = () => act(async () => new Promise<void>((done) => setTimeout(done, 5)));
const panel = () => host.querySelector<HTMLElement>('.np-hoja');
const closeButton = () => host.querySelector<HTMLButtonElement>('.np-hoja-cerrar')!;
const esc = () => act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
const sheetOf = (state: unknown): unknown => (state as { npSheet?: unknown } | null)?.npSheet;

/** Una hoja que se abre y se cierra como en las apps: quien la usa guarda si está abierta. */
function Host({ onClose, stay = false, title = 'Más filtros' }: { onClose?: () => void; stay?: boolean; title?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <Sheet
      open={open}
      title={title}
      onClose={() => {
        onClose?.();
        if (!stay) setOpen(false);
      }}
    >
      <button type="button">dentro</button>
    </Sheet>
  );
}

describe('cerrar: la ✕ y Esc lo piden; el velo, no', () => {
  it('la ✕ y Esc llaman a onClose; tocar fuera no hace nada', async () => {
    const onClose = vi.fn();
    await render(<Host onClose={onClose} stay />);
    await act(async () => host.querySelector<HTMLElement>('.np-hoja-velo')!.click());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => closeButton().click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await esc();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(panel()).not.toBeNull();
  });

  it('el foco entra en la hoja y, al cerrarla, vuelve a donde estaba', async () => {
    const opener = document.body.appendChild(document.createElement('button'));
    opener.focus();
    await render(<Host />);
    expect(document.activeElement).toBe(panel());
    await act(async () => closeButton().click());
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('con dos abiertas, Esc es de la de encima', async () => {
    const below = vi.fn();
    const above = vi.fn();
    await render(
      <>
        <Host onClose={below} title="Debajo" />
        <Host onClose={above} title="Encima" />
      </>,
    );
    await esc();
    expect(above).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    await esc();
    expect(below).toHaveBeenCalledTimes(1);
  });
});

describe('arrastrar hacia abajo (hasta 640 px), desde el asa y la cabecera', () => {
  const pointer = (type: string, el: Element, clientY: number) =>
    act(async () => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY })));

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  });

  it('más de un cuarto del alto: pide cerrar', async () => {
    const onClose = vi.fn();
    await render(<Host onClose={onClose} />);
    const head = host.querySelector('.np-hoja-head')!;
    await pointer('pointerdown', head, 100);
    await pointer('pointermove', head, 200);
    expect(panel()!.style.transform).toBe('translateY(100px)');
    await pointer('pointermove', head, 300);
    await pointer('pointerup', head, 300);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  it('si quien la usa no la cierra (está guardando), vuelve a su sitio en 200 ms', async () => {
    const onClose = vi.fn();
    await render(<Host onClose={onClose} stay />);
    const head = host.querySelector('.np-hoja-head')!;
    await pointer('pointerdown', head, 100);
    await pointer('pointermove', head, 400);
    await pointer('pointerup', head, 400);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel()!.style.transform).toBe('');
    expect(panel()!.style.transition).toContain('200ms');
  });

  it('hacia arriba no se mueve, y la ✕ se pulsa: no arrastra', async () => {
    const onClose = vi.fn();
    await render(<Host onClose={onClose} stay />);
    const head = host.querySelector('.np-hoja-head')!;
    await pointer('pointerdown', head, 300);
    await pointer('pointermove', head, 100);
    expect(panel()!.style.transform).toBe('translateY(0px)');
    await pointer('pointerup', head, 100);
    expect(onClose).not.toHaveBeenCalled();
    await pointer('pointerdown', closeButton(), 100);
    await pointer('pointermove', closeButton(), 500);
    await pointer('pointerup', closeButton(), 500);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('un movimiento corto (10 px) no la cierra', async () => {
    const onClose = vi.fn();
    await render(<Host onClose={onClose} />);
    const head = host.querySelector('.np-hoja-head')!;
    await pointer('pointerdown', head, 100);
    await pointer('pointermove', head, 110);
    await pointer('pointerup', head, 110);
    expect(onClose).not.toHaveBeenCalled();
    expect(panel()!.style.transform).toBe('');
  });

  it('en pantalla ancha no se arrastra', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 641px)' }));
    const onClose = vi.fn();
    await render(<Host onClose={onClose} />);
    const head = host.querySelector('.np-hoja-head')!;
    await pointer('pointerdown', head, 100);
    await pointer('pointermove', head, 500);
    await pointer('pointerup', head, 500);
    expect(onClose).not.toHaveBeenCalled();
    expect(panel()!.style.transform).toBe('');
  });
});

describe('«atrás» cierra la hoja', () => {
  it('al abrir, UNA entrada, con lo que ya había en el historial (lo de Next) y su marca', async () => {
    await render(<Host />);
    expect(history.push).toHaveBeenCalledTimes(1);
    const [state, unused, url] = history.push.mock.calls[0]!;
    expect(state).toMatchObject({ __NA: true });
    expect(typeof sheetOf(state)).toBe('string');
    expect(unused).toBe('');
    // Sin URL: la página no cambia.
    expect(url).toBeUndefined();
    await settle();
    expect(history.push).toHaveBeenCalledTimes(1);
    expect(history.back).not.toHaveBeenCalled();
  });

  it('«atrás» llama a onClose y, cerrada, no hay nada más que quitar', async () => {
    const onClose = vi.fn();
    await render(<Host onClose={onClose} />);
    await history.userBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
    await settle();
    expect(history.back).not.toHaveBeenCalled();
    expect(history.push).toHaveBeenCalledTimes(1);
  });

  it('con dos abiertas, «atrás» cierra solo la de encima', async () => {
    const below = vi.fn();
    const above = vi.fn();
    await render(
      <>
        <Host onClose={below} title="Debajo" />
        <Host onClose={above} title="Encima" />
      </>,
    );
    expect(history.push).toHaveBeenCalledTimes(2);
    await history.userBack();
    expect(above).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.np-hoja')).toHaveLength(1);
    await settle();
    await history.userBack();
    expect(below).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  /** Dos hojas, una encima de otra; «quitar» desmonta la de encima sin cerrarla antes. */
  function Pair({ onBelow }: { onBelow: () => void }) {
    const [top, setTop] = useState(true);
    return (
      <>
        <Host onClose={onBelow} title="Debajo" />
        {top ? <Host title="Encima" /> : null}
        <button type="button" id="quitar" onClick={() => setTop(false)}>
          quitar
        </button>
      </>
    );
  }
  // La de encima es la última del documento: suya es la última ✕.
  const topClose = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.np-hoja-cerrar')).pop()!;

  it.each([
    ['la ✕', () => act(async () => topClose().click())],
    ['Esc', () => esc()],
    ['desmontarla abierta', () => act(async () => host.querySelector<HTMLButtonElement>('#quitar')!.click())],
  ])('%s: UN back(), y el «atrás» que provoca no cierra nada más', async (_how, close) => {
    const below = vi.fn();
    await render(<Pair onBelow={below} />);
    expect(history.push).toHaveBeenCalledTimes(2);
    await close();
    await settle();
    expect(host.querySelectorAll('.np-hoja')).toHaveLength(1);
    expect(history.back).toHaveBeenCalledTimes(1);
    await history.arrive();
    await settle();
    expect(below).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.np-hoja')).toHaveLength(1);
    expect(history.back).toHaveBeenCalledTimes(1);
    // Quedan la entrada de la página y la de la hoja de debajo.
    expect(history.entries()).toHaveLength(2);
    expect(history.push).toHaveBeenCalledTimes(2);
  });

  it('si onClose no la cierra (está guardando), su entrada vuelve: el siguiente «atrás» tampoco sale de la página', async () => {
    const onClose = vi.fn();
    await render(<Host onClose={onClose} stay />);
    const before = sheetOf(history.entries()[1]);
    await history.userBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel()).not.toBeNull();
    await settle();
    expect(history.push).toHaveBeenCalledTimes(2);
    expect(sheetOf(history.entries()[1])).toBe(before);
    await history.userBack();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('una hoja que se cierra y otra que se abre a la vez (el menú que abre «Mi perfil»): la nueva hereda la entrada, sin back()', async () => {
    function Menu() {
      const [at, setAt] = useState<'menu' | 'perfil'>('menu');
      return (
        <>
          <Sheet open={at === 'menu'} onClose={() => undefined} title="Menú">
            <button type="button" id="ir" onClick={() => setAt('perfil')}>
              Mi perfil
            </button>
          </Sheet>
          <Sheet open={at === 'perfil'} onClose={() => undefined} title="Mi perfil">
            x
          </Sheet>
        </>
      );
    }
    await render(<Menu />);
    const menu = sheetOf(history.entries()[1]);
    await act(async () => host.querySelector<HTMLButtonElement>('#ir')!.click());
    await settle();
    expect(host.querySelector('.np-hoja-titulo')!.textContent).toBe('Mi perfil');
    expect(history.back).not.toHaveBeenCalled();
    expect(history.push).toHaveBeenCalledTimes(1);
    expect(history.replace).toHaveBeenCalledTimes(1);
    expect(history.entries()).toHaveLength(2);
    expect(sheetOf(history.entries()[1])).not.toBe(menu);
  });

  it('si encima hay ya otra entrada (se cambió de pestaña desde la hoja), cerrarla no vuelve atrás', async () => {
    await render(<Host />);
    history.foreign({ __NA: true });
    await act(async () => closeButton().click());
    await settle();
    expect(history.back).not.toHaveBeenCalled();
  });

  it('un menú en pantalla ancha no toca el historial: ni entrada ni back()', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 641px)' }));
    function WideMenu() {
      const [open, setOpen] = useState(true);
      const anchor = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button type="button" ref={anchor}>
            Más
          </button>
          <Sheet open={open} onClose={() => setOpen(false)} title="Más opciones" wide="menu" anchorRef={anchor}>
            <button type="button">Exportar</button>
          </Sheet>
        </>
      );
    }
    await render(<WideMenu />);
    const menu = panel()!;
    // Flota: no es modal, sin cabecera, con su título como nombre.
    expect(menu.hasAttribute('aria-modal')).toBe(false);
    expect(menu.className).toBe('np-hoja');
    expect(menu.getAttribute('aria-label')).toBe('Más opciones');
    expect(host.querySelector('.np-hoja-head')).toBeNull();
    expect(host.querySelector('.np-hoja-velo')!.hasAttribute('data-floating')).toBe(true);
    expect(history.push).not.toHaveBeenCalled();
    // Tocar fuera lo cierra.
    await act(async () => host.querySelector<HTMLElement>('.np-hoja-velo')!.click());
    expect(panel()).toBeNull();
    await settle();
    expect(history.back).not.toHaveBeenCalled();
    expect(history.push).not.toHaveBeenCalled();
  });

  it('en el móvil, un `menu` es una hoja como las demás (modal, con su entrada)', async () => {
    await render(
      <Sheet open onClose={() => undefined} title="Más opciones" wide="menu">
        x
      </Sheet>,
    );
    expect(panel()!.getAttribute('aria-modal')).toBe('true');
    expect(panel()!.className).toBe('np-hoja np-modal-panel');
    expect(history.push).toHaveBeenCalledTimes(1);
  });
});
