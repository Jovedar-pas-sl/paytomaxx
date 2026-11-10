import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CASH_UNDO_REASON_LABEL, UNDO_REASON_NEXT, undoOpen, undoneText } from './cash-undo';

const eur = (text: string) => text.split(String.fromCharCode(160)).join(' ');
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('«Me he equivocado» (B4)', () => {
  it('los tres motivos del dueño, y qué pasa con cada uno', () => {
    expect(Object.values(CASH_UNDO_REASON_LABEL)).toEqual(['Importe equivocado', 'Ficha equivocada', 'No llegó a pagar']);
    expect(Object.keys(UNDO_REASON_NEXT)).toEqual(['amount', 'ficha', 'unpaid']);
  });

  it('durante 2 minutos desde CARGADO', () => {
    const at = 1_000_000;
    expect(undoOpen(at, at + 119_000)).toBe(true);
    expect(undoOpen(at, at + 120_000)).toBe(false);
  });

  it('anulada: qué hacer con el efectivo y la ficha', () => {
    expect(eur(undoneText('amount', 5_000))).toBe('Se han quitado 50 €. Vuelve a acercar su ficha y carga el importe bueno; si sobra efectivo, devuélveselo.');
    expect(eur(undoneText('ficha', 5_600))).toMatch(/^Se han quitado 56 € de esa ficha\. Acerca la ficha buena/);
    expect(eur(undoneText('unpaid', 5_000))).toBe('Se han quitado 50 €. No pagó: no hay efectivo que devolver.');
  });

  it('en CARGADO, solo con efectivo, su recarga y una ficha que acercar; con la misma ficha, se anula', () => {
    const desk = read('../components/reception/desk/ReceptionDesk.tsx');
    expect(desk).toMatch(/done\.method === 'cash' && done\.topUpId && done\.loadedAt && needsFichaCheck\(counterFicha\(done\.read\)\)/);
    const same = desk.slice(desk.indexOf('function counterSame('), desk.indexOf('async function counterOther('));
    expect(same).toMatch(/if \(at\.kind === 'undo' && at\.reason && tap\.token && isFreshTap\(meta\.waitedMs\)\) \{\s*void run\(\(\) => undoNow\(at\.done, at\.reason!, tap\)\);/);
  });

  it('pasados los 2 minutos, el encargado o el dueño desde su móvil, con su 2FA', () => {
    const tab = read('../components/reception/ReceptionTab.tsx');
    expect(tab).toMatch(/user\.role === 'MANAGER' \|\| user\.role === 'OWNER'/);
    expect(tab).toContain("setView('voids')");
    const voids = read('../components/reception/CashVoids.tsx');
    expect(voids).toContain('voidCashTopUp(');
    expect(voids).toMatch(/inputMode="numeric"/);
  });
});
