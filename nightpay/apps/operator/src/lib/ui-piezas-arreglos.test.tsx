// @vitest-environment jsdom
import { act, useRef, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Checkbox, ConfirmDialog, Sheet, Toast, useToast } from '@nightpay/ui';
import { resetSheetHistory } from '../../../../packages/ui/src/lib/sheet';
import { toastStore } from '../../../../packages/ui/src/lib/toast';

// «Piezas II», parte B: cuatro arreglos en las piezas de la parte A, que la B
// usa en todas partes. (1) La casilla no lee su pista dos veces; (2) al cerrar
// una pregunta, el foco vuelve a quien la abrió (aunque «Volver» lo tome al
// pintarse); (3) un menú abierto cambia si la pantalla cruza los 641 px, sin
// perder a quien lo abrió; (4) en un móvil, tocar el aviso no lo clava.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetSheetHistory();
  for (const method of ['pushState', 'replaceState', 'back'] as const) vi.spyOn(window.history, method).mockImplementation(() => undefined);
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    toastStore.dismiss();
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = (el: ReactElement) => act(async () => root.render(el));

describe('(1) Checkbox: la pista se lee una vez', () => {
  it('el nombre es solo la etiqueta (aria-labelledby) y la pista, la descripción', () => {
    const html = renderToStaticMarkup(<Checkbox label="Vibración" hint="Al cobrar, el móvil vibra" checked={false} onChange={() => undefined} />);
    const labelId = /<span id="([^"]+)" class="np-checkbox-label">Vibración<\/span>/.exec(html)?.[1];
    const hintId = /<span id="([^"]+)" class="np-checkbox-hint">/.exec(html)?.[1];
    expect(labelId).toBeTruthy();
    expect(hintId).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${labelId}"`);
    expect(html).toContain(`aria-describedby="${hintId}"`);
  });
});

describe('(2) ConfirmDialog: el foco vuelve a quien la abrió', () => {
  it('aunque «Volver» se lleve el foco al pintarse (autoFocus), al cerrar vuelve al botón de la fila', async () => {
    function Row() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" className="abrir" onClick={() => setOpen(true)}>
            Bloquear
          </button>
          <ConfirmDialog open={open} title="¿Bloquear la ficha 522?" confirmLabel="Bloquear ficha" onConfirm={() => undefined} onClose={() => setOpen(false)} />
        </>
      );
    }
    await render(<Row />);
    const opener = host.querySelector<HTMLButtonElement>('.abrir')!;
    opener.focus();
    await act(async () => opener.click());
    expect(document.activeElement?.textContent).toBe('Volver');
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(host.querySelector('.np-hoja')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('(3) Sheet menu: cruza los 641 px abierto', () => {
  it('pasa de hoja a menú flotante al ensanchar la pantalla, y el foco sigue volviendo a su botón', async () => {
    let wide = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query === '(min-width: 641px)' && wide;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
    function Menu() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" ref={anchor} className="abrir" onClick={() => setOpen(true)}>
            Menú
          </button>
          <Sheet open={open} onClose={() => setOpen(false)} title="Menú" wide="menu" anchorRef={anchor}>
            <button type="button">Mi perfil</button>
          </Sheet>
        </>
      );
    }
    await render(<Menu />);
    const opener = host.querySelector<HTMLButtonElement>('.abrir')!;
    opener.focus();
    await act(async () => opener.click());
    const velo = () => host.querySelector<HTMLElement>('.np-hoja-velo')!;
    expect(velo().hasAttribute('data-floating')).toBe(false);
    expect(host.querySelector('.np-hoja-cerrar')).not.toBeNull();
    expect(window.history.pushState).toHaveBeenCalledTimes(1);

    wide = true;
    await act(async () => listeners.forEach((fn) => fn()));
    expect(velo().hasAttribute('data-floating')).toBe(true);
    expect(host.querySelector('.np-hoja')!.getAttribute('aria-modal')).toBeNull();
    // Ya es parte de la página: su entrada de «atrás» se quita.
    await act(async () => Promise.resolve());
    expect(host.querySelector('.np-hoja-cerrar')).toBeNull();

    // Tocar fuera del menú lo cierra; el foco vuelve a su botón, no a lo de dentro.
    await act(async () => velo().click());
    expect(host.querySelector('.np-hoja')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(listeners.size).toBe(0);
  });
});

describe('(4) Toast: con el dedo no se queda clavado', () => {
  const pointer = (type: string, el: Element, pointerType: string) => {
    const e = new MouseEvent(type, { bubbles: true });
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    act(() => void el.dispatchEvent(e));
  };
  let api: ReturnType<typeof useToast>;
  function Caller() {
    api = useToast();
    return null;
  }

  it('un toque (pointerover táctil, sin salir nunca) no para el reloj; el ratón encima, sí', () => {
    vi.useFakeTimers();
    act(() =>
      root.render(
        <>
          <Caller />
          <Toast />
        </>,
      ),
    );
    const toast = () => host.querySelector<HTMLElement>('.np-toast');
    act(() => api.show('Ficha devuelta'));
    pointer('pointerover', toast()!, 'touch');
    act(() => void vi.advanceTimersByTime(5000));
    expect(toast()).toBeNull();

    act(() => api.show('Ficha devuelta'));
    pointer('pointerover', toast()!, 'mouse');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(toast()).not.toBeNull();
    pointer('pointerout', toast()!, 'mouse');
    act(() => void vi.advanceTimersByTime(5000));
    expect(toast()).toBeNull();
  });
});
