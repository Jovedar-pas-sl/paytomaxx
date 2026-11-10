import { readFileSync } from 'node:fs';
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { installHintOffered, installPlatform, isAppleMobile } from '@nightpay/ui';
import { showGuiaLink } from '../components/staff-menu';
import { summarizeCharges } from './open-charges';
import { SAFARI_NOTICE_TEXT, offerStaffInstall, showSafariNotice } from './staff-install';

// Decisión del dueño (Grafito 2): «Instalar en el móvil» de la app del
// personal, solo en Android. En el iPhone y el iPad no se ofrece, y a quien ya
// la tiene instalada se le dice que la ficha y la cámara van en Safari.
// También: «Salir» siempre dentro del menú del logo, y la «Guía rápida» (otra
// página) no sale con un cobro o una recarga abiertos.

Object.assign(globalThis, { React });

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';

/** Lo que ve el personal en este móvil: el aviso de la entrada, el menú y el aviso de Safari. */
function staffSees(env: { userAgent: string; standalone: boolean; hasPrompt: boolean; maxTouchPoints?: number }) {
  const platform = installPlatform(env);
  return {
    entrada: installHintOffered(platform, false),
    menu: offerStaffInstall(platform),
    safari: showSafariNotice(platform, isAppleMobile(env)),
  };
}

describe('instalar la app del personal: solo en Android', () => {
  it('iPhone sin instalar: no se ofrece (ni en la entrada ni en los menús) y no hay aviso', () => {
    expect(staffSees({ userAgent: IPHONE_SAFARI, standalone: false, hasPrompt: false })).toEqual({ entrada: false, menu: false, safari: false });
  });

  it('iPad sin instalar (Safari con user agent de Mac): tampoco', () => {
    expect(staffSees({ userAgent: IPAD_SAFARI, standalone: false, hasPrompt: false, maxTouchPoints: 5 })).toEqual({ entrada: false, menu: false, safari: false });
  });

  it('iPhone o iPad ya instalada: sale el aviso de abrir Safari para la ficha y la cámara', () => {
    expect(staffSees({ userAgent: IPHONE_APP, standalone: true, hasPrompt: false })).toEqual({ entrada: false, menu: false, safari: true });
    expect(staffSees({ userAgent: IPAD_SAFARI, standalone: true, hasPrompt: false, maxTouchPoints: 5 })).toEqual({ entrada: false, menu: false, safari: true });
    expect(SAFARI_NOTICE_TEXT).toBe('Para cobrar con ficha o leer una invitación con la cámara, abre OxioPay en Safari.');
  });

  it('Android: se ofrece en la entrada y en los dos menús; ya instalada, nada', () => {
    expect(staffSees({ userAgent: ANDROID, standalone: false, hasPrompt: true })).toEqual({ entrada: true, menu: true, safari: false });
    expect(staffSees({ userAgent: ANDROID, standalone: true, hasPrompt: false })).toEqual({ entrada: false, menu: false, safari: false });
  });

  it('la entrada pide el aviso sin los pasos del iPhone y enseña el de Safari', () => {
    const page = source('../app/page.tsx');
    expect(page).toContain('<InstallHint ios={false}');
    expect(page).toContain('<SafariNotice ');
  });

  it('«Instalar en el móvil» está en los dos menús del logo (Recepción e Inicio), y sin los pasos del iPhone', () => {
    const staff = source('../components/staff-menu.tsx');
    expect(staff.slice(staff.indexOf('export function StaffMenu('))).toMatch(/<InstallMenuItem \/>\s*<GuiaMenuLink \/>/);
    const cobrar = source('../components/cobrar/CobrarFlow.tsx');
    expect(cobrar.slice(cobrar.indexOf('const menuModal'))).toMatch(/<InstallMenuItem \/>\s*<GuiaMenuLink \/>/);
    expect(staff).not.toContain('IosInstallSteps');
  });

  it('el aviso de Safari en la app, fuera de un cobro abierto', () => {
    expect(source('../components/Dashboard.tsx')).toContain('{charges.open ? null : <SafariNotice />}');
  });
});

describe('«Salir», siempre dentro del menú del logo', () => {
  it('en Cobros, Ganancias y la cola del datáfono, la cabecera es el logo que abre el menú (sin «Salir» suelto)', () => {
    const dash = source('../components/Dashboard.tsx');
    const header = dash.slice(dash.indexOf('<header style={headerStyle}>'), dash.indexOf('</header>'));
    expect(header).toMatch(/<button type="button" className=\{cobrarStyles\.logoTile\} onClick=\{openMenu\} aria-label="Menú">/);
    expect(header).not.toContain('Salir');
    // Ningún botón «Salir» en la pantalla: solo en el menú (StaffMenu).
    expect(dash).not.toMatch(/>\s*Salir\s*</);
  });
});

describe('la «Guía rápida» (otra página) no se lleva un cobro abierto', () => {
  it('sin cobro ni recarga abiertos, sale; con uno, en cualquier pestaña, no', () => {
    expect(showGuiaLink(summarizeCharges(new Map()))).toBe(true);
    for (const spot of ['cobro', 'ficha', 'recepcion'] as const) {
      expect(showGuiaLink(summarizeCharges(new Map([['a', { spot, pending: false }]])))).toBe(false);
    }
  });

  it('en «Comprobando si se han cargado…» no se llega al menú: el logo va quieto', () => {
    const parts = source('../components/reception/desk/desk-parts.tsx');
    expect(parts).toContain('const openMenu = noMenu ? null : menu;');
    expect(parts).toMatch(/\) : openMenu \? \(\s*<button type="button" className=\{s\.logoBtn\} onClick=\{openMenu\} aria-label="Menú">/);
    const desk = source('../components/reception/desk/ReceptionDesk.tsx');
    const unsure = desk.slice(desk.indexOf('function renderCashUnsure('));
    expect(unsure.slice(0, unsure.indexOf('</div>'))).toContain('<DeskHead title="Recepción" sub={name} chip={chip} noMenu />');
  });
});
