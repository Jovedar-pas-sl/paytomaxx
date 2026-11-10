import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HelpAgain, HelpLine, useHelp, type Help } from '../components/HelpLine';

// La pieza de la línea de ayuda que se puede cerrar: abierta, el texto y
// «Entendido»; cerrada, solo el «?» para volver a verla.

// Sin config de vitest propia, los .tsx se compilan aquí con JSX clásico (React.createElement).
Object.assign(globalThis, { React });

const help = (hidden: boolean): Help => ({ hidden, hide: () => undefined, show: () => undefined, okId: 'h-ok', againId: 'h-again' });

function both(h: Help): string {
  return renderToStaticMarkup(
    React.createElement(
      'div',
      null,
      React.createElement(HelpAgain, { help: h }),
      React.createElement(HelpLine, { help: h, children: 'Toca lo que quiere cargar.' }),
    ),
  );
}

describe('la línea de ayuda del personal', () => {
  it('abierta: el texto y «Entendido» (con su nombre para el lector), sin «?»', () => {
    const html = both(help(false));
    expect(html).toContain('Toca lo que quiere cargar.');
    expect(html).toMatch(/<button id="h-ok" type="button"[^>]*aria-label="Entendido, ocultar la ayuda"[^>]*>Entendido<\/button>/);
    expect(html).not.toContain('Ver la ayuda');
  });

  it('cerrada: solo el «?» pequeño para volver a verla', () => {
    const html = both(help(true));
    expect(html).not.toContain('Toca lo que quiere cargar.');
    expect(html).not.toContain('Entendido');
    expect(html).toMatch(/<button id="h-again" type="button"[^>]*aria-label="Ver la ayuda"[^>]*>\?<\/button>/);
  });

  it('en el servidor (sin localStorage) se pinta abierta', () => {
    function Screen() {
      const h = useHelp('cobros');
      return React.createElement(HelpLine, { help: h, children: 'Tus cobros.' });
    }
    expect(renderToStaticMarkup(React.createElement(Screen))).toContain('Entendido');
  });
});
