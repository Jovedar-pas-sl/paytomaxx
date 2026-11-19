import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Guia } from '../components/guia/Guia';
import { GuiaMenuLink, MENU_HINTS } from '../components/staff-menu';
import { GUIA_SECTIONS, guiaSituations } from './guia';

// La «Guía rápida» pintada (/guia) y su entrada en los dos menús del logo:
// el de Recepción (StaffMenu) y el de Inicio (Cobrar).

// Sin config de vitest propia, los .tsx se compilan aquí con JSX clásico (React.createElement).
Object.assign(globalThis, { React });

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe('la página de la guía', () => {
  const html = unescape(renderToStaticMarkup(React.createElement(Guia)));

  it('título, las tres partes con su ancla y la vuelta a la app', () => {
    expect(html).toMatch(/<h1[^>]*>Guía rápida<\/h1>/);
    for (const id of ['cobrar', 'cargar', 'si-pasa']) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
    expect(html).toMatch(/<a href="\/"[^>]*>.*Volver a la app<\/a>/s);
  });

  it('cada paso, numerado, con su frase y su captura (tamaño fijo, texto alternativo, carga diferida)', () => {
    expect(html.match(/<ol /g)).toHaveLength(GUIA_SECTIONS.length);
    for (const s of GUIA_SECTIONS) {
      for (const st of s.steps) {
        expect(html).toContain(st.text);
        expect(html).toContain(`src="${st.image}"`);
        expect(html).toContain(`alt="${st.alt}"`);
        expect(html).toContain(`width="${st.width}" height="${st.height}"`);
      }
    }
    expect(html.match(/loading="lazy"/g)).toHaveLength(GUIA_SECTIONS.flatMap((s) => s.steps).length);
  });

  it('«Qué hago si…»: cada situación y qué hacer', () => {
    for (const c of guiaSituations()) {
      expect(html).toContain(`<dt>${c.when}</dt>`);
      expect(html).toContain(`<dd>${c.todo}</dd>`);
    }
  });

  it('se imprime desde el navegador: en claro, sin «Volver» ni el índice, y sin partir un paso', () => {
    const css = source('../components/guia/guia.module.css');
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(/\.top,\s*\.toc\s*\{\s*display: none;/);
    expect(print).toMatch(/background: #fff/);
    expect(print).toMatch(/--np-text: #15191c/);
    expect(print).toMatch(/break-inside: avoid/);
  });
});

describe('la entrada del menú del logo', () => {
  it('«Guía rápida» lleva a /guia: una fila del menú, con su línea de para qué sirve', () => {
    const html = renderToStaticMarkup(React.createElement(GuiaMenuLink));
    expect(html).toMatch(/^<a href="\/guia" class="[^"]*row[^"]*">/);
    expect(html).toContain('>Guía rápida</span>');
    expect(html).toContain(`>${MENU_HINTS.guia}</span>`);
  });

  it('está en los dos menús (Recepción e Inicio), justo antes de «Salir»', () => {
    const staff = source('../components/staff-menu.tsx');
    const menu = staff.slice(staff.indexOf('export function StaffMenu('));
    expect(menu).toMatch(/<GuiaMenuLink \/>\s*<LogoutMenuItem onLogout=\{onLogout\} \/>/);
    const cobrar = source('../components/cobrar/CobrarFlow.tsx');
    const inicio = cobrar.slice(cobrar.indexOf('const menuModal'));
    expect(inicio).toMatch(/<GuiaMenuLink \/>\s*<LogoutMenuItem onLogout=\{onLogout\} \/>/);
  });
});
