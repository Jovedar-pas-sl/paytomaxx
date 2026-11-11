import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaymentOutcome } from '../../../../packages/ui/src/components/PaymentOutcome';
import { cardHow, cashHow, chargedBy, saldoHow } from '../../../../packages/ui/src/lib/outcome-how';
import { cardFactsOf, pollUpdate } from './payment-status';

// Grafito 3 · puntos 5 y 6: el anillo que respira al esperar y el PAGADO con
// la tarjeta de cómo se pagó (ficha, efectivo, tarjeta). Solo datos del API.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const STAFF = read('../../../../packages/ui/src/staff.css');

// 01:22 en Madrid (en noviembre, UTC+1).
const AT = new Date('2026-11-12T00:22:00Z');

describe('punto 5: el anillo que respira alrededor del QR', () => {
  it('box-shadow que crece y se apaga en 2,6 s, en bucle', () => {
    expect(STAFF).toMatch(/\.np-breathe \{\s*animation: np-breathe 2\.6s ease-in-out infinite;/);
    const frames = STAFF.slice(STAFF.indexOf('@keyframes np-breathe'));
    expect(frames).toContain('0 0 0 0 color-mix');
    expect(frames).toContain('0 0 0 16px color-mix');
    // Solo box-shadow: el QR no cambia de tamaño.
    expect(frames.slice(0, frames.indexOf('.np-breathe'))).not.toMatch(/width|height|transform|scale/);
  });

  it('con «reducir movimiento», un anillo fijo', () => {
    const at = STAFF.indexOf('@media (prefers-reduced-motion: reduce) {\n  .np-breathe');
    expect(at).toBeGreaterThan(0);
    const block = STAFF.slice(at, STAFF.indexOf('\n}\n', at));
    expect(block).toMatch(/animation: none !important;/);
    expect(block).toMatch(/box-shadow: 0 0 0 4px/);
  });

  it('Esperando (operador) y el cobro del TPV lo ponen mientras se espera', () => {
    expect(read('../components/cobrar/Esperando.tsx')).toMatch(/left > 0 \? `\$\{styles\.qr\} np-breathe`/);
    expect(read('../../../tpv/src/components/ActivePayment.tsx')).toMatch(/className=\{deadline \? 'np-breathe' : undefined\}/);
  });
});

describe('punto 6: «cómo se pagó» sin inventar nada', () => {
  it('ficha: número, código tapado, lo que le queda y quién cobró', () => {
    const how = saldoHow({ fichaNumber: '1013', codeHint: 'K7Q-•••', paidWith: 'nfc_nopin', newBalanceCents: 2_600, who: 'Carlos', at: AT });
    expect(how.title).toBe('Con ficha nº 1013');
    expect(how.sub).toBe('Código del saldo K7Q-•••');
    expect(how.rows.map((r) => r.label)).toEqual(['Le quedan', 'Cobró']);
    expect(how.rows[0]!.value.replace(/\s/g, ' ')).toBe('26 €');
    expect(how.rows[1]!.value).toBe('Carlos · 01:22');
  });

  it('ficha sin número impreso: «Con su ficha» (no se inventa el número)', () => {
    const how = saldoHow({ paidWith: 'pin', newBalanceCents: null, who: 'Carlos', at: AT });
    expect(how.title).toBe('Con su ficha');
    expect(how.title).not.toMatch(/\d/);
    expect(how.rows.map((r) => r.label)).toEqual(['Cobró']);
  });

  it('con el móvil: «Face ID o huella»; sin saber cómo, «Con su saldo»', () => {
    expect(saldoHow({ paidWith: 'passkey', newBalanceCents: 500 })).toMatchObject({ title: 'Con su móvil', sub: 'Face ID o huella' });
    expect(saldoHow({ newBalanceCents: null })).toMatchObject({ title: 'Con su saldo', sub: null, rows: [] });
  });

  it('efectivo: «En efectivo · Mételo en la caja» y «Cobró…», sin cambio', () => {
    const how = cashHow({ who: 'Sergio', at: new Date('2026-11-12T00:05:00Z') });
    expect(how).toMatchObject({ kind: 'cash', title: 'En efectivo', sub: 'Mételo en la caja' });
    expect(how.rows).toEqual([{ label: 'Cobró', value: 'Sergio · 01:05' }]);
    // La app no sabe cuánto entregó el cliente: «Le das de cambio» no existe.
    expect(JSON.stringify(how)).not.toMatch(/cambio/i);
  });

  it('tarjeta: ····4021, Apple Pay o Google Pay si el banco lo dijo, código del cobro y quién cobró', () => {
    const how = cardHow({ last4: '4021', payMethod: 'wallet', code: 'K7Q', who: 'Carlos', at: AT });
    expect(how.title).toBe('Con tarjeta ····4021');
    expect(how.sub).toContain('Apple Pay o Google Pay');
    expect(how.rows).toEqual([
      { label: 'Código del cobro', value: 'K7Q', num: true },
      { label: 'Cobró', value: 'Carlos · 01:22' },
    ]);
  });

  it('tarjeta sin cifras ni método: ni cifras ni Apple Pay', () => {
    const how = cardHow({ code: 'K7Q', who: 'Carlos', at: AT });
    expect(how.title).toBe('Con tarjeta');
    expect(how.sub).not.toMatch(/Apple|Google/);
    // Cifras con forma rara: se ignoran.
    expect(cardHow({ last4: '40 1' }).title).toBe('Con tarjeta');
  });

  it('sin nombre (el TPV), la fila es «Hora»; sin nada, ninguna', () => {
    expect(chargedBy('  ', AT)).toBe('01:22');
    expect(cardHow({ at: AT }).rows).toEqual([{ label: 'Hora', value: '01:22' }]);
    expect(cardHow({}).rows).toEqual([]);
  });

  it('el sondeo solo pasa lo que el API dijo y con forma válida', () => {
    expect(cardFactsOf({ status: 'AUTHORIZED', cardLast4: '4021', payMethod: 'wallet' })).toEqual({ cardLast4: '4021', payMethod: 'wallet' });
    expect(cardFactsOf({ status: 'AUTHORIZED', cardLast4: 'abcd', payMethod: 'otro' as never })).toEqual({});
    expect(cardFactsOf({ status: 'AUTHORIZED' })).toEqual({});
    const id = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
    expect(pollUpdate({ id, status: 'AUTHORIZED', tipCents: 0, cardLast4: '4021' }, id)).toMatchObject({ cardLast4: '4021' });
  });

  it('PAGADO pinta el ✓ que se dibuja, la palabra a 64 y la tarjeta debajo del importe', () => {
    const html = renderToStaticMarkup(
      <PaymentOutcome
        kind="paid"
        amountCents={2_400}
        how={saldoHow({ fichaNumber: '1013', codeHint: 'K7Q-•••', paidWith: 'nfc_nopin', newBalanceCents: 2_600, who: 'Carlos', at: AT })}
        primary={{ label: 'Nuevo cobro', onClick: () => undefined }}
      />,
    );
    expect(html).toContain('np-check-ring');
    expect(html).toContain('np-check-tick');
    expect(html).toContain('np-outcome-word');
    expect(html.indexOf('np-outcome-amount')).toBeLessThan(html.indexOf('np-outcome-how'));
    expect(html).toContain('Con ficha nº 1013');
    expect(html).toContain('Le quedan');
    expect(html).toContain('Cobró');
  });

  it('sin `how`, no sale ninguna tarjeta', () => {
    const html = renderToStaticMarkup(<PaymentOutcome kind="paid" amountCents={500} primary={{ label: 'Nuevo cobro', onClick: () => undefined }} />);
    expect(html).not.toContain('np-outcome-how');
  });

  it('la palabra manda: 64 en Manrope 700 y el importe, 40', () => {
    expect(STAFF).toMatch(/\.np-outcome-title\.np-outcome-word \{[^}]*font-weight: 700;[^}]*font-size: var\(--np-fs-64\);/);
    expect(STAFF).toMatch(/\.np-outcome-amount\.np-outcome-amount-sub \{\s*font-size: var\(--np-fs-40\);/);
  });
});
