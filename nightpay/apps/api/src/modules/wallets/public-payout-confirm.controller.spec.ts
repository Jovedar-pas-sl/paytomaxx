import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { PublicPayoutConfirmController } from './public-payout-confirm.controller';
import { renderPayoutConfirmPage } from './reception-payout-page';

/**
 * El QR de la salida de recepción de antes (/w/salida/:token): la salida ya
 * no devuelve el saldo. El cliente que lo abra ve la regla en su idioma y
 * «Ver mi saldo»; confirmar ya no hace nada.
 */
describe('un QR de la salida de antes', () => {
  it('la página dice la regla en el idioma del cliente, sin importes ni el código, y su JS es válido', () => {
    const rules = {
      es: 'El saldo no se devuelve: se queda para la próxima visita.',
      en: 'Your balance is not refunded: it stays for your next visit.',
      pt: 'O saldo não é devolvido: fica para a sua próxima visita.',
    } as const;
    for (const [lang, rule] of Object.entries(rules) as Array<[keyof typeof rules, string]>) {
      const html = renderPayoutConfirmPage('/w/salida/tok', lang);
      expect(html).toContain(rule);
      expect(html).toContain('id="npMine"');
      expect(html).not.toMatch(/€|K7Q|Confirmar con Face ID/);
      for (const part of html.split('<script>').slice(1)) {
        expect(() => new Function(part.slice(0, part.indexOf('</script>')))).not.toThrow();
      }
    }
    // En francés, con su espacio irrompible antes de los dos puntos.
    expect(renderPayoutConfirmPage('/w/salida/tok', 'fr')).toContain(`remboursé${String.fromCharCode(0xa0)}: il reste pour votre prochaine visite.`);
  });

  it('el controlador la sirve (410: esa salida ya no existe) y el reto y la firma dan 409 SALDO_NO_SE_DEVUELVE', async () => {
    const ctrl = new PublicPayoutConfirmController();
    const res = { status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    ctrl.page('tok', 'es', undefined, res as never);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(String(res.send.mock.calls[0]![0])).toContain('El saldo no se devuelve: se queda para la próxima visita.');
    for (const call of [() => ctrl.challenge(), () => ctrl.confirm()]) {
      let err: unknown = null;
      try {
        call();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'SALDO_NO_SE_DEVUELVE' });
    }
  });
});
