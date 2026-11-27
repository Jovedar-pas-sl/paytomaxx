// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sheet } from './Sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

/** Ajustes → una hoja y, encima, otra (la pregunta «¿Ya la has guardado?»). */
function render(first: boolean, second: boolean) {
  act(() =>
    root.render(
      createElement(
        'div',
        null,
        createElement(Sheet, { open: first, onClose: () => undefined, title: 'Clave' }, 'clave'),
        createElement(Sheet, { open: second, onClose: () => undefined, title: '¿Ya la has guardado?' }, 'pregunta'),
      ),
    ),
  );
}

beforeEach(() => {
  document.body.style.overflow = '';
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Sheet: el scroll de la página', () => {
  it('se para al abrir la primera hoja y se devuelve al cerrar la última', () => {
    render(true, false);
    expect(document.body.style.overflow).toBe('hidden');
    render(true, true);
    expect(document.body.style.overflow).toBe('hidden');
    render(true, false);
    expect(document.body.style.overflow).toBe('hidden');
    render(false, false);
    expect(document.body.style.overflow).toBe('');
  });

  it('cerrar dos hojas apiladas a la vez no deja la página bloqueada', () => {
    render(true, false);
    render(true, true);
    render(false, false);
    expect(document.body.style.overflow).toBe('');
  });

  it('cerrar la de abajo antes que la de encima, tampoco', () => {
    render(true, false);
    render(true, true);
    render(false, true);
    expect(document.body.style.overflow).toBe('hidden');
    render(false, false);
    expect(document.body.style.overflow).toBe('');
  });
});
