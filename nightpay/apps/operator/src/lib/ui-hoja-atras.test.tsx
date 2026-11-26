// @vitest-environment jsdom
import { act, useRef, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@nightpay/ui';
import { resetSheetHistory } from '../../../../packages/ui/src/lib/sheet';

// «Piezas II», parte A (idea 50): «atrás» cierra la hoja. Al abrirse, cada hoja
// deja una entrada en el historial del navegador (la misma página, con su
// marca) y la quita al cerrarse. Aquí, con un historial de mentira (se ve cada
// entrada y la prueba decide cuándo llega cada «atrás») y, al final, con el de
// jsdom. El resto de la hoja, en ui-hoja.test.tsx.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it('si se abre otra hoja antes de que llegue el «atrás» de la que se cerró, espera: su entrada se pone cuando llega', async () => {
    function OneAfterAnother() {
      const [at, setAt] = useState<'detalle' | 'nada' | 'devolucion'>('detalle');
      return (
        <>
          <Sheet open={at === 'detalle'} onClose={() => setAt('nada')} title="Detalle del cobro">
            x
          </Sheet>
          <Sheet open={at === 'devolucion'} onClose={() => setAt('nada')} title="Registrar devolución">
            x
          </Sheet>
          <button type="button" id="abrir" onClick={() => setAt('devolucion')}>
            abrir
          </button>
        </>
      );
    }
    await render(<OneAfterAnother />);
    const first = sheetOf(history.entries()[1]);
    await act(async () => closeButton().click());
    await settle();
    expect(history.back).toHaveBeenCalledTimes(1);
    // El «atrás» aún no ha llegado y ya se abre la siguiente.
    await act(async () => host.querySelector<HTMLButtonElement>('#abrir')!.click());
    await settle();
    expect(host.querySelector('.np-hoja-titulo')!.textContent).toBe('Registrar devolución');
    expect(history.push).toHaveBeenCalledTimes(1);
    await history.arrive();
    await settle();
    // Llega: no cierra la nueva, y ahora sí tiene su entrada (la de la primera ya no está).
    expect(host.querySelector('.np-hoja-titulo')!.textContent).toBe('Registrar devolución');
    expect(history.push).toHaveBeenCalledTimes(2);
    expect(history.back).toHaveBeenCalledTimes(1);
    expect(history.entries()).toHaveLength(2);
    expect(sheetOf(history.entries()[1])).not.toBe(first);
    // Y «atrás» la cierra.
    await history.userBack();
    expect(panel()).toBeNull();
  });

  it('si encima hay ya otra entrada (se cambió de pestaña desde la hoja), cerrarla no vuelve atrás', async () => {
    await render(<Host />);
    history.foreign({ __NA: true });
    await act(async () => closeButton().click());
    await settle();
    expect(history.back).not.toHaveBeenCalled();
  });

  it('si el navegador no deja escribir en el historial (Safari corta a las 100 entradas en 30 s), la hoja se abre y se cierra igual', async () => {
    history.push.mockImplementation(() => {
      throw new DOMException('Attempt to use history.pushState() more than 100 times per 30 seconds', 'SecurityError');
    });
    const onClose = vi.fn();
    await render(<Host onClose={onClose} />);
    expect(panel()).not.toBeNull();
    await act(async () => closeButton().click());
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
    // Sin entrada suya, nada que quitar.
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

describe('con el historial de verdad (el de jsdom: su «atrás» llega después, como en un navegador)', () => {
  let pops = 0;
  const onPop = (): void => {
    pops += 1;
  };
  beforeEach(() => {
    pops = 0;
    window.addEventListener('popstate', onPop);
  });
  afterEach(() => window.removeEventListener('popstate', onPop));
  /** Espera (2 s como mucho) a que llegue el «atrás» número `n`: jsdom lo reparte en varias vueltas del reloj y, con la máquina cargada, tarda. */
  const arrived = (n: number) =>
    act(async () => {
      for (let i = 0; i < 200 && pops < n; i += 1) await new Promise<void>((done) => setTimeout(done, 10));
    });

  it('abrir deja la marca en la entrada nueva; cerrar la quita; y se puede volver a abrir', async () => {
    vi.restoreAllMocks();
    const entries = window.history.length;
    const before = window.history.state;
    await render(<Host />);
    expect(typeof sheetOf(window.history.state)).toBe('string');
    expect(window.history.length).toBe(entries + 1);
    await act(async () => closeButton().click());
    await arrived(1);
    expect(window.history.state).toEqual(before);
    // El «atrás» que quitó la entrada ya llegó: la siguiente hoja deja la suya al momento.
    await render(<p>otra pantalla</p>);
    await render(<Host title="Otra" />);
    expect(typeof sheetOf(window.history.state)).toBe('string');
    // «Atrás» del usuario: se cierra y no queda nada pendiente.
    await act(async () => window.history.back());
    await arrived(2);
    expect(panel()).toBeNull();
    expect(window.history.state).toEqual(before);
    await settle();
    expect(pops).toBe(2);
  });
});
