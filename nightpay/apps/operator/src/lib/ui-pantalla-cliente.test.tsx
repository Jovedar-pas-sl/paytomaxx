import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustomerDisplaySheet, PairingSteps } from '../components/CustomerDisplaySheet';

// Menú → «Pantalla del cliente»: arriba, qué es y los 3 pasos para emparejarla.

const noop = () => undefined;
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('«Pantalla del cliente»: qué es y cómo emparejarla', () => {
  const html = renderToStaticMarkup(<CustomerDisplaySheet open onClose={noop} />);
  const shown = text(html);

  it('arriba, qué es: la tablet de la barra con el importe y el QR, la propina, la ficha y «Pagado»', () => {
    expect(shown).toContain('Una tablet en la barra, mirando al cliente');
    expect(shown).toContain('el importe y el QR');
    expect(shown).toContain('elegir la propina y pagar acercando su ficha');
    expect(shown).toContain('«Pagado»');
    expect(shown).toContain('Nunca enseña el saldo');
    expect(shown).toContain('no se puede cancelar ni devolver');
    expect(shown).toContain('Se desempareja sola al cerrar la noche');
  });

  it('los 3 pasos, en una lista numerada: abrir /pantalla, tocar «Emparejar» y escribir el código de 6', () => {
    const steps = html.slice(html.indexOf('<ol'), html.indexOf('</ol>'));
    expect(steps.match(/<li/g)).toHaveLength(3);
    const words = text(steps);
    expect(words).toMatch(/En la tablet, abre \/pantalla/);
    expect(words).toContain('toca «Emparejar»');
    expect(words).toContain('el código de 6 letras y números');
    // La explicación va antes del botón.
    expect(html.indexOf('<ol')).toBeLessThan(html.indexOf('>Emparejar<'));
  });

  it('con una tablet ya emparejada, el paso 2 nombra el botón que sale: «Emparejar otra»', () => {
    const words = text(renderToStaticMarkup(<PairingSteps url="/pantalla" paired />));
    expect(words).toContain('toca «Emparejar otra»');
    expect(text(renderToStaticMarkup(<PairingSteps url="/pantalla" paired={false} />))).toContain('toca «Emparejar» .');
  });
});
