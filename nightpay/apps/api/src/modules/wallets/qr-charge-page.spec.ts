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
    // Face ID preparado al abrir: al tocar "Pagar" sale al momento.
    expect(es).toContain("pkPrepare(C.base+'/challenge')");
    expect(es).toContain('PIN');
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
    now: new Date('2026-10-14T22:00:05Z'),
    receiptHref: null,
    walletHref: '/w/wt?lang=es',
  };

  it('sin Face ID: UNA pregunta (activar, con «Ahora no»), explicada antes; sin PIN en el mismo paso; JS válido', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderPaidPage({ ...base, wallet: { hasFaceId: false, base: '/pay/qr1' } }, lang);
      expect(html).toContain('id="fidOn"');
      expect(html).toContain('id="fidLater"');
      expect(html).not.toContain('id="pinBox"');
      expect(html).not.toContain('id="pkMerge"');
      for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
    }
    const es = renderPaidPage({ ...base, wallet: { hasFaceId: false, base: '/pay/qr1' } }, 'es');
    expect(es).toContain('Ahora no');
    // Palabras de cada plataforma, elegidas en el móvil.
    expect(es).toContain('Activar Face ID');
    expect(es).toContain('huella o bloqueo de pantalla');
    expect(es).toContain('Solo quien desbloquee este móvil puede gastar tu saldo');
    expect(es).toContain("pkCreate(C.base+'/passkey/options')");
    // El PIN y sumar a otro saldo, en la página del saldo.
    expect(es).toContain('href="/w/wt?lang=es#sumar"');
    expect(es).toContain('href="/w/wt?lang=es"');
  });

  it('con Face ID: solo la confirmación, sin pregunta ni «sumar»', () => {
    const html = renderPaidPage({ ...base, wallet: { hasFaceId: true, base: '/pay/qr1' } }, 'es');
    expect(html).not.toContain('#sumar');
    expect(scripts(html).join('\n')).toContain('if(C.hasFaceId)');
    for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
  });

  it('otra recarga (sin saldo nuevo): sin pregunta de Face ID', () => {
    const html = renderPaidPage({ ...base, wallet: null }, 'es');
    expect(html).not.toContain('id="fidOn"');
    expect(html).toContain('Ver mi saldo');
  });
});
