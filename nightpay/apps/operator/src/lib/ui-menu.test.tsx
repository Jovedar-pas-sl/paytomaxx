import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MENU_HINTS, StaffMenu } from '../components/staff-menu';

// El menú del logo (Recepción e Inicio): cada opción dice en una línea para qué sirve.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const noop = () => undefined;
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('el menú del logo: cada opción dice para qué sirve', () => {
  it('Recepción: Mi perfil, Llave de acceso, Pantalla del cliente, Este aparato, Guía rápida y Salir, cada una con su línea', () => {
    const html = renderToStaticMarkup(<StaffMenu open onClose={noop} onLogout={noop} />);
    const shown = text(html);
    const rows: Array<[string, string]> = [
      ['Mi perfil', MENU_HINTS.profile],
      ['Llave de acceso', MENU_HINTS.passkey],
      ['Pantalla del cliente', MENU_HINTS.display],
      ['Este aparato', MENU_HINTS.device],
      ['Guía rápida', MENU_HINTS.guia],
      ['Salir', MENU_HINTS.logout],
    ];
    let at = 0;
    for (const [title, hint] of rows) {
      const i = shown.indexOf(`${title} ${hint}`, at);
      expect(i, `${title}: falta «${hint}» debajo`).toBeGreaterThan(-1);
      at = i;
    }
  });

  it('las líneas son cortas (una línea en el móvil), sin «chica» y sin punto y aparte', () => {
    for (const [key, hint] of Object.entries(MENU_HINTS)) {
      expect(hint.length, key).toBeLessThanOrEqual(46);
      expect(hint, key).not.toMatch(/chica/i);
      expect(hint, key).toMatch(/^[A-ZÁÉÍÓÚ¿].*\.$/);
    }
  });

  it('Inicio (Cobrar) usa las mismas filas, también «Recargar saldo» e «Instalar en el móvil»', () => {
    const cobrar = read('../components/cobrar/CobrarFlow.tsx');
    const menu = cobrar.slice(cobrar.indexOf('const menuModal'), cobrar.indexOf('switch (stage.kind)'));
    for (const key of ['profile', 'topUp', 'display']) expect(menu).toContain(`hint={MENU_HINTS.${key}}`);
    expect(menu).not.toMatch(/<Button\b/);
    const staff = read('../components/staff-menu.tsx');
    expect(staff).toContain('hint={MENU_HINTS.install}');
    expect(staff).toContain('hint={MENU_HINTS.device}');
  });

  it('cada fila: 44 px o más, el nombre a la izquierda y la línea más pequeña y apagada', () => {
    const css = read('../components/staff-menu.module.css');
    expect(css).toMatch(/\.row \{[^}]*min-height: 3\.5rem;/);
    expect(css).toMatch(/\.row \{[^}]*text-align: left;/);
    expect(css).toMatch(/\.hint \{[^}]*font-size: var\(--np-fs-14\);[^}]*color: var\(--np-text-mute\);/);
  });
});
