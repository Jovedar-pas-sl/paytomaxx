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
    receiptHref: null,
    walletHref: '/w/wt?lang=es',
  };

  it('sin Face ID ni PIN: código, "Activar Face ID", "Sumar a mi saldo" y elegir PIN; JS válido', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderPaidPage({ ...base, wallet: { code: 'K7Q-4M2', hasFaceId: false, hasPin: false, base: '/pay/qr1' } }, lang);
      expect(html).toContain('K7Q-4M2');
      expect(html).toContain('id="pkOn"');
      expect(html).toContain('id="pkMerge"');
      expect(html).toContain('id="pinBox"');
      for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
    }
    const es = renderPaidPage({ ...base, wallet: { code: 'K7Q-4M2', hasFaceId: false, hasPin: false, base: '/pay/qr1' } }, 'es');
    expect(es).toContain('Activar Face ID');
    expect(es).toContain('Guardar PIN');
    expect(es).toContain("pkPost(C.base+'/pin'");
  });

  it('con Face ID y sin PIN: el aviso de Face ID y solo el PIN por elegir', () => {
    const html = renderPaidPage({ ...base, wallet: { code: 'K7Q-4M2', hasFaceId: true, hasPin: false, base: '/pay/qr1' } }, 'es');
    expect(html).toContain('Face ID activado');
    expect(html).not.toContain('id="pkOn"');
    expect(html).toContain('id="pinBox"');
    for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
  });

  it('con los dos: solo los avisos, sin botones ni JS', () => {
    const html = renderPaidPage({ ...base, wallet: { code: 'K7Q-4M2', hasFaceId: true, hasPin: true, base: '/pay/qr1' } }, 'es');
    expect(html).toContain('Face ID activado');
    expect(html).toContain('ya tiene PIN');
    expect(html).not.toContain('id="pkOn"');
    expect(html).not.toContain('id="pinBox"');
    expect(scripts(html).some((js) => js.includes('pkCreate'))).toBe(false);
  });
});
