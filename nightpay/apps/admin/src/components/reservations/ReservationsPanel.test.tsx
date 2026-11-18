import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReservationsPanel } from './ReservationsPanel';

// Clientes → Reservados y RRPP: las cuatro vistas con nombres claros, y abrir
// directamente la de los RRPP (desde el atajo de Compañeras).

const tabs = (html: string) => [...html.matchAll(/<button[^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>(?:<[^>]+>)*([^<]+)/g)].map((m) => [m[2], m[1]]);

describe('Reservados y RRPP', () => {
  it('cuatro vistas: Reservas de la noche, Paquetes, RRPP y sus enlaces, Enlace web y señales; empieza en la noche', () => {
    const html = renderToStaticMarkup(<ReservationsPanel isOwner />);
    expect(tabs(html)).toEqual([
      ['Reservas de la noche', 'true'],
      ['Paquetes', 'false'],
      ['RRPP y sus enlaces', 'false'],
      ['Enlace web y señales', 'false'],
    ]);
  });

  it('desde el atajo de Compañeras se abre en los RRPP', () => {
    const html = renderToStaticMarkup(<ReservationsPanel isOwner initialView="promoters" />);
    expect(tabs(html).find(([, sel]) => sel === 'true')?.[0]).toBe('RRPP y sus enlaces');
  });
});
