import { describe, expect, it } from 'vitest';
import { homeTopUpPrintHtml, homeTopUpSummary, queuePosterHtml } from './home-topup';

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

describe('el cartel de la cola (B16)', () => {
  it('«Carga tu saldo mientras esperas», con su línea en inglés, el QR y hasta cuándo vale; sin el enlace escrito', () => {
    const html = queuePosterHtml('data:image/png;base64,AAA', 'las 11:00 del 11/11');
    expect(html).toContain('<h1>Carga tu saldo mientras esperas</h1>');
    expect(html).toContain('lang="en">Top up your balance while you wait</p>');
    expect(html).toContain('<img src="data:image/png;base64,AAA"');
    expect(html).toContain('Vale esta noche, hasta las 11:00 del 11/11.');
    expect(html).toContain('solo te damos la ficha');
    expect(html).not.toContain('NFC');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('/r/');
  });
});
