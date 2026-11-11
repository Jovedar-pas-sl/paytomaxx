import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NightCash } from '@nightpay/contracts';
import { NightCashStep } from './NightCashStep';

// Cierre a ciegas (B9): hasta «Ver si cuadra», ni lo que debería haber ni los
// movimientos que dejan calcularlo (el fondo sí: se apunta aquí).

const CASH: NightCash = {
  openingFloatCents: 20_000,
  cashInCents: 8000,
  walletCashTopUpsCount: 2,
  walletCashTopUpsCents: 8000,
  walletCashPayoutsCount: 1,
  walletCashPayoutsCents: 4500,
  chicaCashPayoutsCount: 1,
  chicaCashPayoutsCents: 9000,
  cashOutCents: 13_500,
  expectedCents: 14_500,
};

const NBSP = new RegExp(String.fromCharCode(160), 'g');
const DISABLED_SHOW = /<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Ver si cuadra/;

function render(countDone: boolean, countedText = '140', firstCountCents: number | null = null): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <NightCashStep
      cash={CASH}
      draft={{ floatText: '', countedText }}
      onDraft={noop}
      cashNote=""
      onCashNote={noop}
      acked={false}
      onAck={noop}
      countDone={countDone}
      onCountDone={noop}
      onRecount={noop}
      firstCountCents={firstCountCents}
      isOwner={false}
      floatCode=""
      onFloatCode={noop}
      floatCodeLockedUntil={null}
    />,
  ).replace(NBSP, ' ');
}

beforeEach(() => {
  vi.stubGlobal('React', React);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('paso «Efectivo» a ciegas', () => {
  it('antes de «Ver si cuadra»: el fondo y lo contado, sin lo esperado, la diferencia ni los movimientos', () => {
    const html = render(false);
    expect(html).toContain('Fondo de caja');
    expect(html).toContain('200,00 €');
    expect(html).toContain('Ver si cuadra');
    expect(html).not.toContain('Debería haber');
    expect(html).not.toContain('145,00 €');
    expect(html).not.toContain('Diferencia');
    expect(html).not.toContain('80,00 €');
    expect(html).not.toContain('45,00 €');
    expect(html).not.toContain('90,00 €');
  });

  it('«Ver si cuadra» no se puede pulsar sin un importe', () => {
    expect(render(false, '')).toMatch(DISABLED_SHOW);
    expect(render(false, '140')).not.toMatch(DISABLED_SHOW);
  });

  it('después: como hoy, con lo esperado, los movimientos y la diferencia', () => {
    const html = render(true);
    expect(html).toContain('Debería haber');
    expect(html).toContain('145,00 €');
    expect(html).toContain('+80,00 €');
    expect(html).toContain('Faltan 5,00 €');
    expect(html).not.toContain('Ver si cuadra');
  });

  it('tras «Ver si cuadra», lo contado (y el fondo) quedan fijos; para corregirlo, «Volver a contar»', () => {
    const counted = (html: string) => html.match(/<input[^>]*value="140"[^>]*>/)?.[0] ?? '';
    expect(counted(render(false))).not.toContain('disabled');
    expect(counted(render(true))).toContain('disabled');
    expect(render(false)).not.toContain('Volver a contar');
    expect(render(true)).toContain('Volver a contar');
    expect(render(true)).toContain('El Z guarda el primer recuento y el nuevo.');
    // Volviendo a contar: a ciegas otra vez, y dice que el primero queda en el Z.
    const again = render(false, '', 14_000);
    expect(again).toContain('Vuelves a contar: el primer recuento (140,00 €) queda en el Z con el nuevo.');
    expect(again).not.toContain('Debería haber');
  });
});
