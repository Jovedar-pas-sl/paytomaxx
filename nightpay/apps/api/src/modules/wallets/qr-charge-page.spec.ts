import { describe, it, expect } from 'vitest';
import { renderQrChargePage } from './qr-charge-page';
import { renderPaidPage } from '../payments/public-pay.pages';

const scripts = (html: string): string[] =>
  html.split('<script>').slice(1).map((part) => part.slice(0, part.indexOf('</script>')));

describe('pagar con el saldo escaneando el QR de la chica', () => {
  const view = {
    status: 'PENDING' as const,
    amountCents: 6000,
    serviceName: 'Masaje',
    venueName: 'Luna',
    requestedByName: 'Lola',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };

  it('importe, servicio y el botón; su JS es válido (si se rompe, el cliente no puede pagar)', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderQrChargePage('tok-1', lang, view);
      expect(html).toContain('id="pay"');
      for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
    }
    const es = renderQrChargePage('tok-1', 'es', view);
    expect(es).toContain('Pagar con mi saldo');
    expect(es).toContain("pkGet(C.base+'/challenge')");
    expect(es).toContain('/s/tok-1');
  });

  it('un nombre con HTML no puede cerrar el <script>', () => {
    const html = renderQrChargePage('tok-1', 'es', { ...view, serviceName: '</script><img src=x onerror=alert(1)>' });
    expect(html).not.toContain('</script><img');
  });
});

describe('"Pagado" de la recarga que creó el saldo', () => {
  const base = {
    amountCents: 20_000,
    tipCents: 0,
    currency: 'EUR',
    code: 'A1B',
    authorizedAt: new Date('2026-10-14T22:00:00Z'),
    receiptHref: null,
    walletHref: '/w/wt?lang=es',
  };

  it('sin Face ID: código, "Activar Face ID" y "Sumar a mi saldo"; JS válido', () => {
    const html = renderPaidPage({ ...base, wallet: { code: 'K7Q-4M2', hasFaceId: false, base: '/pay/qr1' } }, 'es');
    expect(html).toContain('K7Q-4M2');
    expect(html).toContain('Activar Face ID');
    expect(html).toContain('Sumar a mi saldo');
    for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
  });

  it('con Face ID ya activado: solo el aviso, sin botones', () => {
    const html = renderPaidPage({ ...base, wallet: { code: 'K7Q-4M2', hasFaceId: true, base: '/pay/qr1' } }, 'es');
    expect(html).toContain('Face ID activado');
    expect(html).not.toContain('id="pkOn"');
  });
});
