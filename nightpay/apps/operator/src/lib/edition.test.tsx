import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAYMENT_METHODS } from '@nightpay/contracts';
import { TabBar } from '../components/TabBar';
import { editionOf, isParty, pulseraText } from './edition';
import { editionAccess, partyAccess, partyTabs } from './party-tabs';
import { roleAccess } from './roles';
import { parseTab, resolveTab } from './tab-url';
import { visibleTabsFor } from './venue-methods';

// OxioParty va detrás de NEXT_PUBLIC_EDITION=party. Con cualquier otro valor
// (o sin él) es OxioPay y nada cambia: estas pruebas lo comprueban en las dos.

afterEach(() => {
  vi.unstubAllEnvs();
});

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('la edición', () => {
  it('solo «party» es OxioParty; cualquier otro valor, OxioPay', () => {
    expect(editionOf('party')).toBe('party');
    expect(editionOf(' Party ')).toBe('party');
    for (const raw of [undefined, null, '', 'club', 'oxiopay', 'parties']) expect(editionOf(raw)).toBe('club');
  });

  it('isParty() lee NEXT_PUBLIC_EDITION', () => {
    vi.stubEnv('NEXT_PUBLIC_EDITION', 'party');
    expect(isParty()).toBe(true);
    vi.stubEnv('NEXT_PUBLIC_EDITION', 'club');
    expect(isParty()).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_EDITION', '');
    expect(isParty()).toBe(false);
  });

  it('se lee con el nombre literal (Next lo pone al compilar)', () => {
    expect(read('./edition.ts')).toContain('process.env.NEXT_PUBLIC_EDITION');
  });
});

describe('«pulsera» donde OxioPay dice «ficha»', () => {
  it('en OxioParty, con su mayúscula y su plural', () => {
    expect(pulseraText('Acerca otra vez la ficha', true)).toBe('Acerca otra vez la pulsera');
    expect(pulseraText('Ficha nº 0522 · sin saldo', true)).toBe('Pulsera nº 0522 · sin saldo');
    expect(pulseraText('Preparar fichas', true)).toBe('Preparar pulseras');
    expect(pulseraText('Fichas y recargas', true)).toBe('Pulseras y recargas');
  });

  it('en OxioPay, el texto tal cual', () => {
    expect(pulseraText('Acerca otra vez la ficha', false)).toBe('Acerca otra vez la ficha');
    vi.stubEnv('NEXT_PUBLIC_EDITION', 'club');
    expect(pulseraText('Sin móvil ni ficha')).toBe('Sin móvil ni ficha');
  });
});

describe('las pestañas de OxioParty', () => {
  it('quedan Cobrar, Taquilla, Cobros y Ajustes (sin Ganancias ni POS)', () => {
    expect(partyTabs(['home', 'payments', 'reception', 'pos'])).toEqual(['home', 'reception', 'payments', 'settings']);
    expect(partyTabs(['home', 'payments', 'earnings'])).toEqual(['home', 'payments', 'settings']);
  });

  it('no se piden el saldo, la noche ni las invitaciones de la chica, ni la cola del datáfono', () => {
    for (const role of ['OPERATOR', 'WAITER', 'MANAGER', 'OWNER'] as const) {
      const access = partyAccess(roleAccess(role));
      expect(access.ownEarnings).toBe(false);
      expect(access.posQueue).toBe(false);
      expect(access.tabs).not.toContain('earnings');
      expect(access.tabs).not.toContain('pos');
    }
  });

  it('la Taquilla, solo a quien carga pulseras y con el saldo encendido (como la Recepción)', () => {
    const tabs = partyAccess(roleAccess('WAITER')).tabs;
    expect(visibleTabsFor(tabs, DEFAULT_PAYMENT_METHODS, true)).toEqual(['home', 'reception', 'payments', 'settings']);
    expect(visibleTabsFor(tabs, DEFAULT_PAYMENT_METHODS, false)).toEqual(['home', 'payments', 'settings']);
  });

  it('?t=ajustes abre Ajustes en OxioParty; en OxioPay no existe y lleva a Inicio', () => {
    expect(parseTab('?t=ajustes')).toBe('settings');
    expect(resolveTab('settings', ['home', 'reception', 'payments', 'settings'])).toBe('settings');
    expect(resolveTab('settings', roleAccess('WAITER').tabs)).toBe('home');
  });

  it('la barra de abajo: «Cobrar», «Taquilla», «Cobros», «Ajustes»', () => {
    vi.stubEnv('NEXT_PUBLIC_EDITION', 'party');
    const html = renderToStaticMarkup(<TabBar tabs={['home', 'reception', 'payments', 'settings']} active="home" onSelect={() => undefined} />);
    expect(html).toContain('aria-label="Cobrar"');
    expect(html).toContain('aria-label="Taquilla"');
    expect(html).toContain('aria-label="Cobros"');
    expect(html).toContain('aria-label="Ajustes"');
  });
});

describe('en OxioPay (edición club) todo sigue igual', () => {
  it.each(['OPERATOR', 'WAITER', 'MANAGER', 'OWNER'] as const)('%s: lo que ve su rol, el mismo objeto de siempre', (role) => {
    const access = roleAccess(role);
    expect(editionAccess(access, false)).toBe(access);
    expect(access.tabs).not.toContain('settings');
  });

  it('las pestañas de siempre, con sus nombres de siempre', () => {
    vi.stubEnv('NEXT_PUBLIC_EDITION', 'club');
    const html = renderToStaticMarkup(<TabBar tabs={roleAccess('WAITER').tabs} active="home" onSelect={() => undefined} />);
    for (const label of ['Inicio', 'Cobros', 'Recepción', 'POS']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('Taquilla');
    expect(html).not.toContain('Ajustes');
  });

  it('sin edición puesta, también OxioPay', () => {
    vi.stubEnv('NEXT_PUBLIC_EDITION', undefined as unknown as string);
    expect(isParty()).toBe(false);
    const html = renderToStaticMarkup(<TabBar tabs={roleAccess('OPERATOR').tabs} active="home" onSelect={() => undefined} />);
    expect(html).toContain('aria-label="Inicio"');
    expect(html).toContain('aria-label="Ganancias"');
  });

  it('el «Modo día» solo entra en el arranque de OxioParty', () => {
    expect(read('../app/layout.tsx')).toContain("${isParty() ? DAY_INIT_SCRIPT : ''}");
  });

  it('cada pantalla nueva va detrás de isParty(): Inicio, la recepción, la espera del cobro y el Dashboard', () => {
    expect(read('../components/HomeTab.tsx')).toMatch(/isParty\(\)/);
    expect(read('../components/cobrar/CobrarFlow.tsx')).toMatch(/party \? \(\s*<>\s*<Barra/);
    expect(read('../components/cobrar/Esperando.tsx')).toMatch(/isParty\(\)/);
    expect(read('../components/reception/desk/ReceptionDesk.tsx')).toMatch(/isParty\(\)/);
    expect(read('../components/Dashboard.tsx')).toMatch(/editionAccess\(roleAccess\(user\.role\), party\)/);
  });
});
