import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Z_NET_LABEL, Z_NET_WITHOUT_STAFF_LABEL } from '@nightpay/contracts';
import { zNetLabel, zTypeLabel } from './z-labels';

describe('nombres de las líneas del Z', () => {
  it('un Z congelado antes de dejar de decir «wallet» se enseña con el nombre de ahora', () => {
    expect(zTypeLabel('Recarga de wallet')).toBe('Recarga con tarjeta');
  });

  it('lo demás, tal cual (secciones, recargas en efectivo, nombres del local)', () => {
    for (const label of ['Recarga con tarjeta', 'Recarga en efectivo', 'Copas', 'Reservados VIP', 'Servicio de chica + Habitación']) {
      expect(zTypeLabel(label)).toBe(label);
    }
  });
});

describe('el neto del Z sin el personal', () => {
  it('un Z de ahora (trae la parte de los camareros, aunque sea 0): «Neto sin el personal»', () => {
    expect(zNetLabel({ camareroNetCents: 0 })).toBe('Neto sin el personal');
    expect(zNetLabel({ camareroNetCents: 600 })).toBe('Neto sin el personal');
    // El mismo nombre que en el resumen de las 9:00 (alert-messages.ts).
    expect(zNetLabel({ camareroNetCents: 0 })).toBe(Z_NET_WITHOUT_STAFF_LABEL);
  });

  it('un Z congelado antes (sin la parte de los camareros): solo restaba lo de las chicas', () => {
    expect(zNetLabel({})).toBe('Neto sin las chicas');
  });
});

describe('los dos «neto» del Z se llaman distinto (prueba real: el Z decía «neto 1.733 €» y el resumen «neto sin el personal 1.626 €»)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const panel = read('../components/NightsPanel.tsx');
  const close = read('../components/NightCloseScreen.tsx');

  it('lo cobrado menos lo devuelto: «Neto (cobrado − devuelto)», que no se confunde con los «sin el personal»', () => {
    expect(Z_NET_LABEL).toBe('Neto (cobrado − devuelto)');
    expect(Z_NET_LABEL).not.toBe(zNetLabel({ camareroNetCents: 0 }));
    expect(Z_NET_LABEL).not.toBe(zNetLabel({}));
  });

  it('Noches (la lista, el Z y sus ajustes) y el Z recién congelado: ninguna cifra se llama solo «Neto»', () => {
    expect(panel).not.toMatch(/\['Neto',/);
    expect(panel).not.toMatch(/>Neto</);
    expect(panel).not.toMatch(/data-label="Neto"/);
    expect(panel.match(/\[Z_NET_LABEL, s\.netCents\]/g)).toHaveLength(2);
    expect(panel).toMatch(/<th style=\{numHead\}>\{Z_NET_LABEL\}<\/th>/);
    expect(close).not.toMatch(/· neto\{' '\}/);
    expect(close).toMatch(/\{Z_NET_LABEL\}:\{' '\}\s*<strong className="np-num">\{formatEur\(s\.netCents\)\}<\/strong>/);
  });
});
