// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTourSession, tourKey, type TourStep } from '../lib/tour';
import { HelpButton, ScreenHelp, Tour, findTourTarget } from './Tour';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECT = { x: 20, y: 100, left: 20, top: 100, right: 220, bottom: 140, width: 200, height: 40, toJSON: () => ({}) } as DOMRect;
const isHidden = (el: Element) => el.closest('[hidden]') !== null;

const steps: TourStep[] = [
  { target: 'a', title: 'Título A', text: 'Texto A' },
  { target: 'b', title: 'Título B', text: 'Texto B' },
  { target: 'c', title: 'Título C', text: 'Texto C' },
];

let host: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  act(() => root.render(node));
}
const click = (el: Element | null) => act(() => void (el as HTMLElement).click());
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const buttonByText = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;
const keydown = (key: string, init: KeyboardEventInit = {}) =>
  act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })));

function Page({ ids = ['a', 'b', 'c'], children }: { ids?: string[]; children?: ReactNode }) {
  return createElement(
    'div',
    null,
    ids.map((id) => createElement('div', { key: id, 'data-tour': id }, id)),
    children,
  );
}

/** Los elementos primero y el tutorial después (como en la app: se abre con la pantalla ya pintada). */
function mountTour(onClose: () => void = () => {}, ids?: string[]) {
  render(createElement(Page, { ids }));
  render(createElement(Page, { ids }, createElement(Tour, { steps, onClose })));
}

beforeEach(() => {
  localStorage.clear();
  resetTourSession();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return isHidden(this) ? ({ ...RECT, width: 0, height: 0 } as DOMRect) : RECT;
  });
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (isHidden(this) ? [] : [RECT]) as unknown as DOMRectList;
  });
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Tour', () => {
  it('es un diálogo modal con título y texto, y el foco dentro', () => {
    mountTour();
    const dialog = q('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Título A');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('Texto A');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.textContent).toContain('1 de 3');
  });

  it('avanza con Siguiente, vuelve con Atrás y en el último dice Entendido y termina', () => {
    const onClose = vi.fn();
    mountTour(onClose);
    expect(buttonByText('Atrás')).toBeNull();
    click(buttonByText('Siguiente'));
    expect(q('.np-tour-title')!.textContent).toBe('Título B');
    expect(q('.np-tour-count')!.textContent).toBe('2 de 3');
    click(buttonByText('Atrás'));
    expect(q('.np-tour-title')!.textContent).toBe('Título A');
    click(buttonByText('Siguiente'));
    click(buttonByText('Siguiente'));
    expect(buttonByText('Siguiente')).toBeNull();
    click(buttonByText('Entendido'));
    expect(onClose).toHaveBeenCalledWith('done');
  });

  it('salta el paso cuyo elemento no está en pantalla', () => {
    mountTour(() => {}, ['a', 'c']);
    expect(q('.np-tour-count')!.textContent).toBe('1 de 2');
    click(buttonByText('Siguiente'));
    expect(q('.np-tour-title')!.textContent).toBe('Título C');
  });

  it('un elemento escondido (hidden) cuenta como que no está', () => {
    const tree = (withTour: boolean) =>
      createElement(
        'div',
        null,
        createElement('div', { hidden: true }, createElement('div', { 'data-tour': 'a' }, 'a')),
        createElement('div', { 'data-tour': 'b' }, 'b'),
        withTour ? createElement(Tour, { steps, onClose: () => {} }) : null,
      );
    render(tree(false));
    render(tree(true));
    expect(findTourTarget('a')).toBeNull();
    expect(q('.np-tour-title')!.textContent).toBe('Título B');
  });

  it('Saltar y Escape cierran con su motivo', () => {
    const onClose = vi.fn();
    mountTour(onClose);
    click(buttonByText('Saltar'));
    expect(onClose).toHaveBeenLastCalledWith('skip');
    keydown('Escape');
    expect(onClose).toHaveBeenLastCalledWith('escape');
  });

  it('sin ningún elemento, se cierra sin dejarlo visto y no pinta nada', () => {
    const onClose = vi.fn();
    mountTour(onClose, []);
    expect(onClose).toHaveBeenCalledWith('empty');
    expect(q('[role="dialog"]')).toBeNull();
  });

  it('Tab no sale de la burbuja', () => {
    mountTour();
    click(buttonByText('Siguiente'));
    const dialog = q('[role="dialog"]')!;
    const buttons = Array.from(dialog.querySelectorAll('button'));
    buttons.at(-1)!.focus();
    keydown('Tab');
    expect(document.activeElement).toBe(buttons[0]);
    keydown('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(buttons.at(-1));
  });

  it('los botones miden 48 px o más y el «?» 44 px', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'tour.css'), 'utf8');
    expect(css).toMatch(/\.np-tour-btn\s*\{[^}]*min-height:\s*3rem/);
    expect(css).toMatch(/\.np-tour-skip\s*\{[^}]*min-height:\s*3rem/);
    expect(css).toMatch(/\.np-help-btn\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/);
  });
});

describe('HelpButton', () => {
  it('lleva el aria-label de la ayuda', () => {
    render(createElement(HelpButton, { onClick: () => {} }));
    expect(q('button')!.getAttribute('aria-label')).toBe('Ayuda: cómo funciona esta pantalla');
  });
});

describe('ScreenHelp: la primera vez y el «?»', () => {
  const screen = (ready = true) => createElement(Page, null, createElement(ScreenHelp, { screen: 'prueba', steps, ready }));
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it('sale sola la primera vez, queda vista al terminar y no vuelve a salir', () => {
    vi.useFakeTimers();
    render(screen());
    expect(q('[role="dialog"]')).toBeNull();
    advance(700);
    expect(q('[role="dialog"]')).not.toBeNull();
    click(buttonByText('Saltar'));
    expect(q('[role="dialog"]')).toBeNull();
    expect(localStorage.getItem(tourKey('prueba'))).toBe('1');
    // Otra visita a la pantalla: no sale sola.
    act(() => root.unmount());
    root = createRoot(host);
    render(screen());
    advance(3000);
    expect(q('[role="dialog"]')).toBeNull();
  });

  it('con «?» sale siempre, aunque ya la haya visto', () => {
    localStorage.setItem(tourKey('prueba'), '1');
    render(screen());
    click(q('.np-help-btn'));
    expect(q('[role="dialog"]')).not.toBeNull();
    keydown('Escape');
    expect(q('[role="dialog"]')).toBeNull();
    click(q('.np-help-btn'));
    expect(q('[role="dialog"]')).not.toBeNull();
  });

  it('Escape también la deja vista', () => {
    vi.useFakeTimers();
    render(screen());
    advance(700);
    keydown('Escape');
    expect(localStorage.getItem(tourKey('prueba'))).toBe('1');
  });

  it('no sale con un cobro abierto (ready=false) y sale en cuanto la pantalla queda libre', () => {
    vi.useFakeTimers();
    render(screen(false));
    advance(5000);
    expect(q('[role="dialog"]')).toBeNull();
    expect(localStorage.getItem(tourKey('prueba'))).toBeNull();
    render(screen(true));
    advance(700);
    expect(q('[role="dialog"]')).not.toBeNull();
  });

  it('si llega un cobro con el tutorial abierto solo, se cierra sin dejarlo visto', () => {
    vi.useFakeTimers();
    render(screen(true));
    advance(700);
    expect(q('[role="dialog"]')).not.toBeNull();
    render(screen(false));
    expect(q('[role="dialog"]')).toBeNull();
    expect(localStorage.getItem(tourKey('prueba'))).toBeNull();
  });

  it('no salta si hay una ventana (modal) encima, y espera a que se cierre', () => {
    vi.useFakeTimers();
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    render(screen());
    advance(3000);
    expect(q('.np-tour')).toBeNull();
    modal.remove();
    advance(1500);
    expect(q('.np-tour')).not.toBeNull();
  });

  it('una pantalla que es su propia ventana (data-tour-host) no cuenta como una ventana encima', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('data-tour-host', '');
    document.body.appendChild(host);
    render(screen());
    advance(700);
    expect(q('.np-tour')).not.toBeNull();
    host.remove();
  });

  it('con el «?», si no queda ningún elemento a la vista, no pinta nada ni lo deja visto', () => {
    render(createElement(Page, { ids: [] }, createElement(ScreenHelp, { screen: 'vacia', steps })));
    click(q('.np-help-btn'));
    expect(q('[role="dialog"]')).toBeNull();
    expect(localStorage.getItem(tourKey('vacia'))).toBeNull();
  });
});
