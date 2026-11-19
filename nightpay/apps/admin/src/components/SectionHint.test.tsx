import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SECTION_HINTS, visibleSections, type PanelViewer } from '@/lib/roles';
import { SectionHint } from './SectionHint';

// La línea bajo las pestañas de cada sección y, en Compañeras, el atajo a los
// RRPP (son personas del equipo, pero se llevan en Clientes → Reservados y RRPP).

const noop = () => undefined;
const sectionOf = (viewer: PanelViewer, key: string) => visibleSections(viewer).find((s) => s.key === key)!;
const render = (viewer: PanelViewer, key: string) =>
  renderToStaticMarkup(<SectionHint section={sectionOf(viewer, key)} tabs={visibleSections(viewer).flatMap((s) => s.tabs)} onOpenRrpp={noop} />);

describe('la línea de cada sección', () => {
  it('enseña lo que hay dentro de la sección', () => {
    for (const s of visibleSections({ role: 'OWNER' })) {
      expect(render({ role: 'OWNER' }, s.key)).toContain(SECTION_HINTS[s.key]);
    }
  });

  it('en Compañeras, un botón «RRPP y sus enlaces» (dueño y encargado), con su marca para el tutorial', () => {
    for (const role of ['OWNER', 'MANAGER']) {
      const html = render({ role }, 'chicas');
      expect(html).toMatch(/<button[^>]*data-tour="chicas-rrpp"[^>]*>(<[^>]+>)*RRPP y sus enlaces/);
    }
  });

  it('en las demás secciones, sin atajo', () => {
    for (const key of ['hoy', 'clientes', 'informes', 'ajustes']) expect(render({ role: 'OWNER' }, key)).not.toContain('<button');
  });

  it('sin Reservados a la vista, sin atajo', () => {
    const chicas = sectionOf({ role: 'OWNER' }, 'chicas');
    const html = renderToStaticMarkup(<SectionHint section={chicas} tabs={chicas.tabs} onOpenRrpp={noop} />);
    expect(html).not.toContain('RRPP y sus enlaces');
  });
});
