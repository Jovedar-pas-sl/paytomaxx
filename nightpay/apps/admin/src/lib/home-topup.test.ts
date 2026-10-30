import { describe, expect, it } from 'vitest';
import { homeTopUpPrintHtml, homeTopUpSummary } from './home-topup';

const NBSP = String.fromCharCode(0xa0);

describe('«Cargar saldo desde casa» en Ajustes', () => {
  it('lo que verá el cliente, sin comisión', () => {
    // Los importes llevan espacio irrompible antes de «€».
    expect(homeTopUpSummary({ minCents: 1000, maxCents: 30000, serviceFeeBps: null }).split(NBSP).join(' ')).toBe(
      'De 10,00 € a 300,00 €, en euros enteros. Paga con Apple Pay, Google Pay o tarjeta. El saldo no caduca.',
    );
  });

  it('con la comisión del servicio de las recargas, su % encima', () => {
    expect(homeTopUpSummary({ minCents: 1000, maxCents: 30000, serviceFeeBps: 1050 })).toContain(
      'con la comisión del servicio de las recargas (10,5 %) encima',
    );
    expect(homeTopUpSummary({ minCents: 1000, maxCents: 30000, serviceFeeBps: 0 })).not.toContain('comisión');
  });

  it('la hoja para imprimir lleva el QR y el enlace (escapados)', () => {
    const html = homeTopUpPrintHtml('data:image/png;base64,AAA', 'https://api.x/r/Ab"<c');
    expect(html).toContain('<img src="data:image/png;base64,AAA"');
    expect(html).toContain('https://api.x/r/Ab&quot;&lt;c');
    expect(html).not.toContain('<script');
  });
});
