import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NIGHT_SETTINGS, nightSettingsOf } from '@nightpay/contracts';
import { lostFichaPlan } from './lost-ficha';

const eur = (text: string) => text.split(String.fromCharCode(160)).join(' ');
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('«Ficha perdida» en recepción (B6)', () => {
  it('3 € de fábrica, un ajuste por local (0 = gratis)', () => {
    expect(DEFAULT_NIGHT_SETTINGS.lostFichaFeeCents).toBe(300);
    expect(nightSettingsOf({ lostFichaFeeCents: 500 }).lostFichaFeeCents).toBe(500);
    expect(nightSettingsOf({ lostFichaFeeCents: 0 }).lostFichaFeeCents).toBe(0);
    expect(nightSettingsOf({ lostFichaFeeCents: -1 }).lostFichaFeeCents).toBe(300);
  });

  it('antes de confirmar, cuánto cuesta y cuánto le quedará; si no le llega, se dice y no se hace', () => {
    const ok = lostFichaPlan(3_500, 300);
    expect(ok.ok).toBe(true);
    expect(eur(ok.text)).toBe('La ficha nueva cuesta 3 € de su saldo: le quedan 35 € y le quedarán 32 €. La vieja deja de pagar en cuanto acerques la nueva.');
    const poor = lostFichaPlan(200, 300);
    expect(poor.ok).toBe(false);
    expect(eur(poor.text)).toBe('No le llega el saldo: le quedan 2 € y la ficha nueva cuesta 3 €. Que cargue antes.');
    expect(lostFichaPlan(0, 0).ok).toBe(true);
  });

  it('la pantalla manda lo que dijo y solo deja acercar la nueva si le llega', () => {
    const screen = read('../components/reception/LostFicha.tsx');
    expect(screen).toContain('feeCents,');
    expect(screen).toMatch(/\{plan\.ok \? \(/);
    // Las tres pruebas: su QR, su código o el número de su ficha (y su PIN).
    expect(screen).toContain('Escanear su QR');
    expect(screen).toContain('Buscar con el código');
    expect(screen).toContain('Buscar con el número');
    expect(read('../components/reception/ReceptionTab.tsx')).toContain("setView('lost')");
  });
});
