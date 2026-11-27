// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Banner, ICON_PATHS, Toast, TONE_COLORS, toastBottom, useToast, type IconName } from '@nightpay/ui';
import { TOAST_ACTION_MS, TOAST_MS, toastStore } from '../../../../packages/ui/src/lib/toast';

// «Piezas II», parte A (idea 52): cuatro clases de aviso. El flotante (useToast
// y Toast: algo que salió bien o un «Deshacer», y se va solo) y la franja
// (Banner: un estado que dura, sin reloj). Un error nunca flota ni se va solo.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UI = '../../../../packages/ui/src/';
const ADMIN = '../../../admin/src/';
const PIECES2 = read(`${UI}pieces-2.css`);

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

/** Los trazos del primer dibujo que hay en ese marcado. */
const paths = (html: string): string[] => [...html.slice(0, html.indexOf('</svg>')).matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!);

describe('toastBottom: 16 px sobre el pie fijo más alto', () => {
  const alto = 740;

  it('sin pie fijo: lo decide el CSS (16 px del borde; 24 con ratón)', () => {
    expect(toastBottom([], alto)).toBeNull();
  });

  it('sobre la barra de pestañas', () => {
    expect(toastBottom([{ top: 672, bottom: 740 }], alto)).toBe(68 + 16);
  });

  it('sobre el pie de Cobrar, que va pegado encima de la barra de pestañas (aunque los separe un píxel)', () => {
    const rects = [
      { top: 672, bottom: 740 },
      { top: 560, bottom: 671 },
    ];
    expect(toastBottom(rects, alto)).toBe(740 - 560 + 16);
    // El orden en que se midan no cambia nada.
    expect(toastBottom([...rects].reverse(), alto)).toBe(740 - 560 + 16);
  });

  it('un pie a media pantalla no cuenta (el de una ventana centrada): el aviso cabe debajo', () => {
    expect(toastBottom([{ top: 480, bottom: 560 }], alto)).toBeNull();
    expect(
      toastBottom(
        [
          { top: 672, bottom: 740 },
          { top: 300, bottom: 380 },
        ],
        alto,
      ),
    ).toBe(68 + 16);
    // Justo lo que ocupa el aviso con sus dos huecos (16 + 48 + 16): cabe debajo.
    expect(toastBottom([{ top: 600, bottom: 660 }], alto)).toBeNull();
  });

  it('un pie casi pegado al borde sí (la ficha del panel en el ordenador, a 16 px): debajo no cabría el aviso', () => {
    expect(toastBottom([{ top: 652, bottom: 724 }], alto)).toBe(740 - 652 + 16);
    expect(toastBottom([{ top: 600, bottom: 661 }], alto)).toBe(740 - 600 + 16);
  });

  it('con una hoja abierta sobre la barra de pestañas, manda el pie más alto de los dos', () => {
    const rects = [
      { top: 672, bottom: 740 },
      { top: 650, bottom: 740 },
    ];
    expect(toastBottom(rects, alto)).toBe(740 - 650 + 16);
    expect(toastBottom([...rects].reverse(), alto)).toBe(740 - 650 + 16);
  });

  it('lo que no se ve (escondido, o fuera de la pantalla) tampoco', () => {
    expect(
      toastBottom(
        [
          { top: 0, bottom: 0 },
          { top: 740, bottom: 808 },
        ],
        alto,
      ),
    ).toBeNull();
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    toastStore.dismiss();
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const render = (el: ReactElement) => act(() => root.render(el));
const region = () => host.querySelector<HTMLElement>('.np-toast-region')!;
const toast = () => host.querySelector<HTMLElement>('.np-toast');
const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

/** Quien avisa: en las apps, cualquier componente con `const toast = useToast()`. */
let api: ReturnType<typeof useToast>;
function Caller() {
  api = useToast();
  return null;
}
const mount = () =>
  render(
    <>
      <Caller />
      <Toast />
    </>,
  );

describe('Toast: el aviso flotante', () => {
  it('la región está siempre (el lector de pantalla la escucha), vacía hasta que hay algo', () => {
    mount();
    expect(region().getAttribute('role')).toBe('status');
    expect(region().getAttribute('aria-live')).toBe('polite');
    expect(toast()).toBeNull();
    expect(renderToStaticMarkup(<Toast />)).toBe('<div class="np-toast-region" role="status" aria-live="polite"></div>');
  });

  it('show(texto): sale con su icono de 20 y se va solo a los 5 s', () => {
    mount();
    act(() => api.show('Ahora no hace falta la ficha'));
    expect(toast()!.textContent).toBe('Ahora no hace falta la ficha');
    expect(toast()!.dataset.tone).toBe('info');
    const icon = toast()!.querySelector('svg')!;
    expect(icon.getAttribute('width')).toBe('20');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(paths(toast()!.innerHTML)).toEqual([...ICON_PATHS.info]);
    expect(TOAST_MS).toBe(5000);
    pass(4999);
    expect(toast()).not.toBeNull();
    pass(1);
    expect(toast()).toBeNull();
  });

  it('`tone: "success"`: con su ✓', () => {
    mount();
    act(() => api.show('Te han invitado · +10 €', { tone: 'success' }));
    expect(toast()!.dataset.tone).toBe('success');
    expect(paths(toast()!.innerHTML)).toEqual([...ICON_PATHS.check]);
  });

  it('con «Deshacer» dura 10 s; tocarlo deshace y lo quita', () => {
    mount();
    const undo = vi.fn();
    act(() => api.show('Ficha devuelta', { action: { label: 'Deshacer', onClick: undo } }));
    expect(TOAST_ACTION_MS).toBe(10000);
    pass(9999);
    const action = toast()!.querySelector<HTMLButtonElement>('.np-toast-action')!;
    expect(action.type).toBe('button');
    expect(action.textContent).toBe('Deshacer');
    expect(toast()!.querySelector('.np-toast-text')!.textContent).toBe('Ficha devuelta');
    pass(1);
    expect(toast()).toBeNull();
    expect(undo).not.toHaveBeenCalled();

    act(() => api.show('Ficha devuelta', { action: { label: 'Deshacer', onClick: undo } }));
    act(() => toast()!.querySelector<HTMLButtonElement>('.np-toast-action')!.click());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(toast()).toBeNull();
  });

  it('el nuevo sustituye al anterior y su reloj empieza de cero', () => {
    mount();
    act(() => api.show('Ficha devuelta'));
    pass(4000);
    act(() => api.show('Ahora no hace falta la ficha'));
    expect(host.querySelectorAll('.np-toast')).toHaveLength(1);
    expect(toast()!.textContent).toBe('Ahora no hace falta la ficha');
    pass(4999);
    expect(toast()).not.toBeNull();
    pass(1);
    expect(toast()).toBeNull();
  });

  it('el ratón encima o el foco dentro paran el reloj; al irse, vuelve a contar', () => {
    mount();
    act(() => api.show('Ficha devuelta', { action: { label: 'Deshacer', onClick: () => undefined } }));
    pass(9000);
    // Con ratón (pointerType «mouse»): el dedo no para el reloj (ui-piezas-arreglos.test.tsx).
    const mouse = (type: string) => {
      const e = new MouseEvent(type, { bubbles: true });
      Object.defineProperty(e, 'pointerType', { value: 'mouse' });
      act(() => void toast()!.dispatchEvent(e));
    };
    mouse('pointerover');
    pass(60_000);
    expect(toast()).not.toBeNull();
    mouse('pointerout');
    pass(9999);
    expect(toast()).not.toBeNull();
    const action = toast()!.querySelector<HTMLButtonElement>('.np-toast-action')!;
    act(() => action.focus());
    pass(60_000);
    expect(toast()).not.toBeNull();
    act(() => action.blur());
    pass(10_000);
    expect(toast()).toBeNull();
  });

  it('solo avisa de lo que salió bien: el tipo no admite danger ni warning (un error nunca flota)', () => {
    mount();
    // @ts-expect-error un error va en un FormError o en un Banner, que no se van solos
    act(() => api.show('No se pudo cobrar', { tone: 'danger' }));
    // @ts-expect-error
    act(() => api.show('Ojo', { tone: 'warning' }));
    expect(read(`${UI}lib/toast.ts`)).toMatch(/tone\?: 'success' \| 'info';/);
  });

  it('useToast da siempre lo mismo: se puede poner en las dependencias de un efecto', () => {
    const seen: unknown[] = [];
    function Twice() {
      seen.push(useToast());
      return null;
    }
    render(<Twice />);
    render(<Twice />);
    expect(seen[0]).toBe(seen[1]);
  });

  it('al salir mide los pies fijos ([data-np-foot] y los botones del resultado) y se pone 16 px encima', () => {
    mount();
    const bar = document.body.appendChild(document.createElement('nav'));
    bar.setAttribute('data-np-foot', '');
    bar.getBoundingClientRect = () => ({ top: window.innerHeight - 68, bottom: window.innerHeight }) as DOMRect;
    const actions = document.body.appendChild(document.createElement('div'));
    actions.className = 'np-outcome-actions';
    actions.getBoundingClientRect = () => ({ top: window.innerHeight - 200, bottom: window.innerHeight - 68 }) as DOMRect;
    act(() => api.show('Ficha devuelta'));
    expect(region().style.bottom).toBe('216px');
    bar.remove();
    actions.remove();
    // Sin pie: el sitio de siempre, el del CSS.
    act(() => api.show('Ficha devuelta'));
    expect(region().style.bottom).toBe('');
    expect(read(`${UI}components/Toast.tsx`)).toContain("'[data-np-foot], .np-outcome-actions'");
  });
});

describe('Toast: cómo se ve', () => {
  it('la región no estorba al dedo; el aviso sí se toca', () => {
    const box = rule(PIECES2, '.np-toast-region');
    expect(box).toContain('position: fixed;');
    expect(box).toContain('pointer-events: none;');
    expect(box).toContain('justify-content: center;');
    // A 16 px del borde; donde hay zona segura (el gesto de inicio del móvil), por encima de ella. Aparte, en su @supports.
    expect(box).toContain('bottom: 16px;');
    expect(PIECES2).toMatch(/@supports \(padding-bottom: env\(safe-area-inset-bottom\)\) \{\s*\.np-toast-region \{\s*bottom: calc\(16px \+ env\(safe-area-inset-bottom\)\);\s*\}\s*\}/);
    expect(rule(PIECES2, '.np-toast')).toContain('pointer-events: auto;');
  });

  it('con ratón, desde 641 px, a 24 del borde', () => {
    expect(PIECES2).toMatch(/@media \(min-width: 641px\) and \(hover: hover\) and \(pointer: fine\) \{\s*\.np-toast-region \{\s*bottom: 24px;\s*\}\s*\}/);
  });

  it('48 de alto como mínimo, un paso más claro, radio 14, la sombra de lo que flota y 16/500', () => {
    const css = rule(PIECES2, '.np-toast');
    expect(css).toContain('min-height: 48px;');
    expect(css).toContain('background: var(--np-surface-3);');
    expect(css).toContain('border-radius: var(--np-r-md);');
    expect(css).toContain('box-shadow: var(--np-shadow-2);');
    expect(css).toContain('font-size: var(--np-fs-16);');
    expect(css).toContain('font-weight: 500;');
    // Si no cabe, dos líneas: nunca cortado.
    expect(css).not.toMatch(/nowrap|ellipsis/);
  });

  it('«Deshacer», en el color de actuar y con 44 de toque', () => {
    const action = rule(PIECES2, '.np-toast-action');
    expect(action).toContain('color: var(--np-accent);');
    expect(action).toContain('min-height: 44px;');
    expect(action).toContain('min-width: 44px;');
  });
});

describe('quién lleva data-np-foot (el aviso se pone encima)', () => {
  it.each([
    ['la hoja', `${UI}components/Sheet.tsx`, 1],
    ['la barra de pestañas del personal', '../components/TabBar.tsx', 1],
    ['la barra de abajo del panel', `${ADMIN}components/BottomNav.tsx`, 1],
    ['la ficha del panel', `${ADMIN}components/fichas/FichaSheet.tsx`, 1],
    ['la carta', '../components/cobrar/Carta.tsx', 1],
    ['la espera del cobro (sus dos pies)', '../components/cobrar/Esperando.tsx', 2],
    ['la cuenta', '../components/cobrar/LaCuenta.tsx', 1],
    ['otro importe', '../components/cobrar/OtroImporte.tsx', 1],
  ])('%s', (_what, file, times) => {
    expect(read(file).match(/data-np-foot/g)).toHaveLength(times);
  });

  it('en cada pie de Cobrar, la marca va en el propio pie', () => {
    const feet: Record<string, number> = { Carta: 1, Esperando: 2, LaCuenta: 1, OtroImporte: 1 };
    for (const [file, times] of Object.entries(feet)) {
      const src = read(`../components/cobrar/${file}.tsx`);
      // La etiqueta entera del pie (la marca puede ir antes o después de su clase).
      const tags = [...src.matchAll(/<div\b[^>]*className=\{[^}]*styles\.foot\b[^>]*>/g)].map((m) => m[0]);
      expect(tags, file).toHaveLength(times);
      for (const tag of tags) expect(tag, file).toContain('data-np-foot=""');
    }
    expect(read(`${ADMIN}components/fichas/FichaSheet.tsx`)).toContain('<div className="np-sheet-foot" data-np-foot="">');
  });
});

describe('los dos avisos flotantes de antes ya son el común', () => {
  it('«Te han invitado»: con su importe, en verde y con su sonido; sin caja ni reloj propios', () => {
    const src = read('../components/InvitationToast.tsx');
    // Tras el cobro por el encargado, el mismo aviso dice dos cosas («Servicio cobrado» y «Te han invitado»): el texto va en «what».
    expect(src).toContain("{ what: 'Te han invitado', cents: invited }");
    expect(src).toContain("toast.show(`${what} · +${formatEur(cents, { compact: true })}`, { tone: 'success' })");
    expect(src).toContain("playOutcomeSound('paid')");
    expect(src).not.toMatch(/setTimeout|position: 'fixed'|SHOW_MS|zIndex/);
    // El aviso es de toda la app: al salir de la sesión se quita, no se queda en la pantalla de entrar.
    expect(src).toContain('useEffect(() => () => toast.dismiss(), [toast]);');
  });

  it('«Ahora no hace falta la ficha»', () => {
    const src = read('../components/NfcEscucha.tsx');
    expect(src).toContain('toast.show(IDLE_TAP_TEXT)');
    expect(src).not.toMatch(/setTimeout|position: 'fixed'|SHOW_MS|zIndex/);
  });

  it('<Toast /> va una vez en el layout de cada app', () => {
    for (const app of ['operator', 'admin']) {
      const layout = read(`../../../${app}/src/app/layout.tsx`);
      expect(layout.match(/<Toast \/>/g), app).toHaveLength(1);
    }
  });
});

describe('Banner: la franja que se queda', () => {
  const ICON: Record<'success' | 'warning' | 'danger' | 'info' | 'neutral', IconName> = {
    success: 'check',
    warning: 'alert',
    danger: 'error',
    info: 'info',
    neutral: 'info',
  };

  it.each(['success', 'warning', 'danger', 'info', 'neutral'] as const)('%s: su icono de 20, su filete y su fondo', (tone) => {
    const html = renderToStaticMarkup(<Banner tone={tone}>Aún no tienes cuenta de cobro.</Banner>);
    expect(html).toContain(`class="np-banner" data-tone="${tone}"`);
    expect(html).toContain(`role="${tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}"`);
    expect(html).toContain(`style="--np-banner-c:${TONE_COLORS[tone].color};background:${TONE_COLORS[tone].background}"`);
    expect(html).toContain('width="20" height="20"');
    expect(paths(html)).toEqual([...ICON_PATHS[ICON[tone]]]);
    expect(html).toContain('<div class="np-banner-text">Aún no tienes cuenta de cobro.</div>');
    // Sin acción ni cierre, ningún botón.
    expect(html).not.toContain('<button');
  });

  it('`title`: una línea en negrita delante del texto', () => {
    const html = renderToStaticMarkup(
      <Banner tone="warning" title="Sin cuenta de cobro">
        Ponla para que te paguen.
      </Banner>,
    );
    expect(html).toContain('<strong class="np-banner-title">Sin cuenta de cobro</strong>Ponla para que te paguen.');
  });

  it('`action`: un botón secundario; `onClose`: la ✕ «Cerrar aviso» (solo entonces)', () => {
    render(
      <Banner tone="warning" action={{ label: 'Cómo poner mi cuenta', onClick: () => undefined }}>
        Aún no tienes cuenta de cobro.
      </Banner>,
    );
    const action = host.querySelector<HTMLButtonElement>('.np-banner button')!;
    expect(action.textContent).toBe('Cómo poner mi cuenta');
    expect(action.dataset.variant).toBe('ghost');
    expect(action.dataset.size).toBe('sm');
    expect(host.querySelector('[aria-label="Cerrar aviso"]')).toBeNull();

    const onClose = vi.fn();
    const help = vi.fn();
    render(
      <Banner tone="info" action={{ label: 'Entendido', onClick: help }} onClose={onClose}>
        Hay una versión nueva.
      </Banner>,
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Cerrar aviso"]')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => host.querySelector<HTMLButtonElement>('.np-banner-main button')!.click());
    expect(help).toHaveBeenCalledTimes(1);
  });

  it('acepta className y style (los márgenes de quien la usa), sin perder su tono', () => {
    const html = renderToStaticMarkup(
      <Banner tone="danger" className="np-set-note" style={{ marginTop: '1rem' }}>
        x
      </Banner>,
    );
    expect(html).toContain('class="np-banner np-set-note"');
    expect(html).toContain(`style="--np-banner-c:${TONE_COLORS.danger.color};background:${TONE_COLORS.danger.background};margin-top:1rem"`);
  });

  it('sin reloj: no se va sola', () => {
    expect(read(`${UI}components/Banner.tsx`)).not.toMatch(/setTimeout|setInterval|useEffect/);
  });

  it('texto 14/500 (16 en la app táctil), radio 12, el icono del color del tono y el texto en el normal', () => {
    const css = rule(PIECES2, '.np-banner');
    expect(css).toContain('border: 1px solid var(--np-banner-c);');
    expect(css).toContain('border-radius: var(--np-r-inner);');
    expect(css).toContain('font-size: var(--np-fs-14);');
    expect(css).toContain('font-weight: 500;');
    expect(css).toContain('color: var(--np-text);');
    expect(rule(PIECES2, '.np-touch .np-banner')).toContain('font-size: var(--np-fs-16);');
    expect(rule(PIECES2, '.np-banner > svg')).toContain('color: var(--np-banner-c);');
    // El botón, a la derecha o debajo si no cabe.
    expect(rule(PIECES2, '.np-banner-main')).toContain('flex-wrap: wrap;');
  });

  it('el Notice del panel pinta la franja común (sus 91 usos no cambian; +2 de la ficha de la compañera y +1 de su documento)', () => {
    const notice = read(`${ADMIN}components/Notice.tsx`);
    expect(notice).toContain('<Banner tone={tone} action={action} style={style}>');
    expect(notice).not.toMatch(/boxStyle|TONE_COLORS|role=/);
    // Con rutas y no con URL: en jsdom, el URL global no es el de Node y readdirSync no lo admite.
    let uses = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) uses += readFileSync(path, 'utf8').match(/<Notice\b/g)?.length ?? 0;
      }
    };
    walk(join(dirname(fileURLToPath(import.meta.url)), ADMIN, 'components'));
    expect(uses).toBe(91);
  });
});
