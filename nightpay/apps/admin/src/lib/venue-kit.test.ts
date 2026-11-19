import { describe, expect, it } from 'vitest';
import { counterTentHtml, doorStickersHtml, KIT_ASSETS, receptionPosterHtml, type KitOptions } from './venue-kit';

const QR = 'data:image/png;base64,QRQR';
const on: KitOptions = { venueName: 'Bar <b>"Luna"</b> & Co', qr: QR };
const off: KitOptions = { venueName: 'Luna', qr: null };
const sheets = { expositor: counterTentHtml, pegatina: doorStickersHtml, recepcion: receptionPosterHtml };

describe('material para el local', () => {
  for (const [name, build] of Object.entries(sheets)) {
    describe(name, () => {
      it('es A4, imprime los colores y lleva español e inglés', () => {
        const html = build(on);
        expect(html).toContain('@page{size:A4;margin:0}');
        expect(html).toContain('print-color-adjust:exact');
        expect(html).toContain('lang="en"');
        expect(html).toContain(KIT_ASSETS.symbol);
      });

      it('el QR solo sale si el enlace está encendido (la pegatina no lleva)', () => {
        expect(build(on).includes(QR)).toBe(name !== 'pegatina');
        expect(build(off)).not.toContain('QRQR');
        expect(build(off)).not.toContain('class="qr"');
      });

      it('no promete nada que no haya', () => {
        expect(build(on)).not.toMatch(/Google Wallet|devol|reembols|refund/i);
      });
    });
  }

  it('el expositor dice cómo se paga en la barra y su QR de saldo', () => {
    const html = counterTentHtml(on);
    expect(html).toContain('Paga con OxioPay');
    expect(html).toContain('Pay with OxioPay');
    expect(html).toContain('Carga o mira tu saldo');
    expect(html).toContain('Top up or check your balance');
    expect(html).toContain('Apple Pay, Google Pay o tu saldo');
    expect(counterTentHtml(off)).not.toContain('Carga o mira tu saldo');
  });

  it('la pegatina: cuatro redondas de 100 mm con el texto de puerta', () => {
    const html = doorStickersHtml(on);
    expect(html.match(/class="st"/g)).toHaveLength(4);
    expect(html).toContain('width:100mm;height:100mm;border-radius:50%');
    expect(html).toContain('Aquí se paga con OxioPay');
    expect(html).toContain('We accept OxioPay');
    expect(html).toContain('Tarjeta · Apple Pay · Google Pay · Tu saldo');
  });

  it('el cartel de recepción lleva el local escapado', () => {
    const html = receptionPosterHtml(on);
    expect(html).toContain('Carga tu saldo aquí');
    expect(html).toContain('Top up here');
    expect(html).toContain('Bar &lt;b&gt;&quot;Luna&quot;&lt;/b&gt; &amp; Co');
    expect(html).not.toContain('<b>"Luna"');
  });

  it('las letras de la marca van por @font-face si se pasan, y el inglés corregido', () => {
    const fonts = { sans: 'https://x/s.woff2', num: 'https://x/n.woff2' };
    const html = receptionPosterHtml({ ...on, fonts });
    expect(html).toContain('@font-face{font-family:OxioSans;src:url("https://x/s.woff2")');
    expect(html).toContain('font-family:OxioNum');
    expect(receptionPosterHtml(on)).not.toContain('@font-face');
    expect(html).toContain('Tell us how much you want to top up.');
    expect(html).toContain('All set: pay with your balance at the venue.');
    expect(html).toContain('Anything left over stays in your balance for your next visit.');
  });

  it('el nombre del local se escapa en todas las hojas', () => {
    for (const build of Object.values(sheets)) expect(build({ venueName: '<script>x</script>', qr: null })).not.toContain('<script>');
  });
});
