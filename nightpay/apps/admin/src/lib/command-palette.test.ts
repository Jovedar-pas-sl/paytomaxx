import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CobroRow } from '@nightpay/contracts';
import {
  PALETTE_LIMIT,
  accionesDe,
  filaCobro,
  filaFicha,
  pantallasDe,
  personasDe,
  queBuscar,
  sinTildes,
} from './command-palette';
import { visibleSections } from './roles';

const OWNER = visibleSections({ role: 'OWNER', isSuperAdmin: false, canSeeReports: true, posOn: true, partnersOn: false }, 'club');
const MANAGER = visibleSections({ role: 'MANAGER', isSuperAdmin: false, canSeeReports: false, posOn: true, partnersOn: false }, 'club');
const tabsOf = (sections: typeof OWNER) => sections.flatMap((s) => s.tabs);

describe('sin tildes', () => {
  it('ni mayúsculas ni tildes ni eñes cuentan', () => {
    expect(sinTildes('Compañeras')).toBe('companeras');
    expect(sinTildes('  RESUMÉN ')).toBe('resumen');
  });

  it('pantallas: solo las que ve el rol, buscando sin tildes', () => {
    expect(pantallasDe(OWNER, 'companeras').map((p) => p.key)).toEqual(['operators', 'treasury']);
    expect(pantallasDe(OWNER, 'mapa').map((p) => p.key)).toEqual(['money']);
    // El encargado sin informes no ve el mapa ni Informes.
    expect(pantallasDe(MANAGER, 'mapa')).toEqual([]);
    expect(pantallasDe(MANAGER, 'informes')).toEqual([]);
    expect(pantallasDe(OWNER, 'a').length).toBeLessThanOrEqual(PALETTE_LIMIT);
    expect(pantallasDe(OWNER, '')).toEqual([]);
  });
});

describe('acciones por rol: solo navegan, un destino cada una', () => {
  it('el dueño con la noche abierta: Cerrar noche (no Abrir), Nueva compañera, Pagar a compañeras y Descargar informes', () => {
    const a = accionesDe({ tabs: tabsOf(OWNER), isOwner: true, canCloseNight: true, night: 'open' }, '');
    expect(a.map((x) => x.label)).toEqual(['Cerrar noche', 'Nueva compañera', 'Pagar a compañeras', 'Descargar informes']);
  });

  it('sin noche abierta: Abrir noche, que lleva a Noches', () => {
    const a = accionesDe({ tabs: tabsOf(OWNER), isOwner: true, canCloseNight: true, night: 'none' }, 'noche');
    expect(a).toEqual([{ id: 'abrir-noche', label: 'Abrir noche', destino: { tab: 'nights' } }]);
  });

  it('sin saber si hay noche (aún o si falló): ni cerrar ni abrir', () => {
    const a = accionesDe({ tabs: tabsOf(OWNER), isOwner: true, canCloseNight: true, night: 'unknown' }, 'noche');
    expect(a).toEqual([]);
  });

  it('el encargado: sin «Descargar informes»; «Cerrar noche» solo con su permiso', () => {
    const sin = accionesDe({ tabs: tabsOf(MANAGER), isOwner: false, canCloseNight: false, night: 'open' }, '');
    expect(sin.map((x) => x.label)).not.toContain('Cerrar noche');
    expect(sin.map((x) => x.label)).not.toContain('Descargar informes');
    const con = accionesDe({ tabs: tabsOf(MANAGER), isOwner: false, canCloseNight: true, night: 'open' }, 'cerrar');
    expect(con).toEqual([{ id: 'cerrar-noche', label: 'Cerrar noche', destino: { tab: 'resumen', cerrarNoche: true } }]);
  });

  it('cada acción, solo un destino (una pestaña que el rol ve): ninguna hace nada con el dinero', () => {
    for (const [sections, isOwner] of [[OWNER, true], [MANAGER, false]] as const) {
      const tabs = tabsOf(sections);
      for (const night of ['open', 'none'] as const) {
        for (const a of accionesDe({ tabs, isOwner, canCloseNight: true, night }, '')) {
          expect(Object.keys(a).sort()).toEqual(['destino', 'id', 'label']);
          expect(tabs.some((t) => t.key === a.destino.tab), a.label).toBe(true);
          expect(Object.keys(a.destino).filter((k) => k !== 'tab').length).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(accionesDe({ tabs: tabsOf(OWNER), isOwner: true, canCloseNight: true, night: 'open' }, 'nueva')).toEqual([
      { id: 'nueva-companera', label: 'Nueva compañera', destino: { tab: 'operators', nuevaCompanera: true } },
    ]);
    expect(accionesDe({ tabs: tabsOf(OWNER), isOwner: true, canCloseNight: true, night: 'open' }, 'pagar')).toEqual([
      { id: 'pagar', label: 'Pagar a compañeras', destino: { tab: 'treasury' } },
    ]);
  });
});

describe('qué dispara cobros o fichas', () => {
  it('cobros desde 3 letras; fichas con «ficha 522» o solo cifras', () => {
    expect(queBuscar('C-')).toEqual({ cobros: null, ficha: null });
    expect(queBuscar('C-0022')).toEqual({ cobros: 'C-0022', ficha: null });
    expect(queBuscar(' marta ')).toEqual({ cobros: 'marta', ficha: null });
    expect(queBuscar('ficha 522')).toEqual({ cobros: 'ficha 522', ficha: '522' });
    expect(queBuscar('Ficha522')).toEqual({ cobros: 'Ficha522', ficha: '522' });
    expect(queBuscar('52')).toEqual({ cobros: null, ficha: '52' });
    expect(queBuscar('522')).toEqual({ cobros: '522', ficha: '522' });
    expect(queBuscar('ficha')).toEqual({ cobros: 'ficha', ficha: null });
    expect(queBuscar('x'.repeat(200)).cobros).toHaveLength(128);
  });

  it('la fila de un cobro: «C-0022 · 02:14 · 33,00 €»; sin ref no sale', () => {
    const row = { ref: 'C-0022', createdAt: '2026-11-15T01:14:00.000Z', amountCents: 3_000, tipCents: 300, serviceFeeCents: 0, currency: 'EUR', kind: 'PAYMENT' } as CobroRow;
    expect(filaCobro(row, 'Europe/Madrid')?.replace(/\u00a0/g, ' ')).toBe('C-0022 · 02:14 · 33,00 €');
    expect(filaCobro({ ...row, ref: null }, 'Europe/Madrid')).toBeNull();
  });

  it('la fila de una ficha: «Ficha 522 · Entregada»', () => {
    expect(filaFicha({ printedNumber: '522', status: 'ISSUED' })).toBe('Ficha 522 · Entregada');
    expect(filaFicha({ printedNumber: null, status: 'STOCK' })).toBe('Ficha sin número · En stock');
  });

  it('personas: solo el nombre y si es compañera o camarero; nunca el correo', () => {
    const chicas = [
      { id: 'a', displayName: 'Marta', email: 'marta@x.es' },
      { id: 'b', displayName: null, email: 'secreta@x.es' },
    ];
    const camareros = [{ id: 'c', displayName: 'Martín', email: 'martin@x.es' }];
    expect(personasDe(chicas, camareros, 'mart')).toEqual([
      { id: 'a', nombre: 'Marta', tipo: 'Compañera' },
      { id: 'c', nombre: 'Martín', tipo: 'Camarero' },
    ]);
    expect(personasDe(chicas, camareros, 'secreta')).toEqual([]);
    expect(JSON.stringify(personasDe(chicas, camareros, 'm'))).not.toContain('@');
  });
});

describe('CommandPalette en el código', () => {
  const src = readFileSync(new URL('../components/CommandPalette.tsx', import.meta.url), 'utf8');
  const dash = readFileSync(new URL('../components/Dashboard.tsx', import.meta.url), 'utf8');

  it('la lupa y Ctrl+K en el Dashboard (no en OxioParty)', () => {
    expect(dash).toContain('icon="search"');
    expect(dash).toContain('label="Buscar (Ctrl+K)"');
    expect(dash).toContain('<CommandPalette');
  });

  it('una sola consulta del saldo, al elegir la ficha; nunca al teclear', () => {
    expect(src.match(/lookupWalletCode\(/g)).toHaveLength(1);
    expect(src).toContain('AbortController');
    expect(src).not.toMatch(/localStorage|sessionStorage/);
  });

  it('el campo es un combobox y la lista un listbox', () => {
    expect(src).toContain('role="combobox"');
    expect(src).toContain('aria-activedescendant');
    expect(src).toContain('role="listbox"');
    expect(src).toContain('Busca un cobro, una persona, una ficha o una pantalla');
  });
});
