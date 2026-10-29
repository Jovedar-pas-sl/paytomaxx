import { describe, expect, it } from 'vitest';
import { formatEur } from './money';
import {
  bankHoldLine,
  payoutHoldNote,
  releaseBlockText,
  releaseConfirmText,
  releaseErrorText,
  saleVia,
} from './bank-holds';

describe('ventas por datáfono sin cuadrar con el banco (ficha de la chica y pago)', () => {
  it('la línea de la ficha: importe y cuántas ventas; sin nada retenido (o un API anterior), nada', () => {
    expect(bankHoldLine({ bankHeldCents: 18_000, bankHeldCount: 1 })).toBe(`Pendiente de cuadrar con el banco: ${formatEur(18_000)} (1 venta por datáfono)`);
    expect(bankHoldLine({ bankHeldCents: 54_050, bankHeldCount: 3 })).toBe(`Pendiente de cuadrar con el banco: ${formatEur(54_050)} (3 ventas por datáfono)`);
    expect(bankHoldLine({ bankHeldCents: 0, bankHeldCount: 0 })).toBeNull();
    expect(bankHoldLine({})).toBeNull();
  });

  it('en el pago: lo retenido no entra y se dice cuándo se paga', () => {
    expect(payoutHoldNote({ bankHeldCents: 18_000, bankHeldCount: 1 })).toBe(
      `No entra en este pago: ${formatEur(18_000)} de 1 venta por datáfono pendientes de cuadrar con el banco. Se pagan al cuadrar el fichero del banco o si el dueño las libera.`,
    );
    expect(payoutHoldNote({ bankHeldCents: 0 })).toBeNull();
  });

  it('cómo se dio por cobrada: el camarero con su ticket, o el datáfono sin la prueba de Paytef', () => {
    expect(saleVia({ via: 'camarero', confirmedBy: 'Carlos', receiptRef: 'ABC123' })).toBe('confirmada por Carlos · ticket ABC123');
    expect(saleVia({ via: 'camarero', confirmedBy: null, receiptRef: null })).toBe('confirmada por un camarero');
    expect(saleVia({ via: 'datafono', confirmedBy: 'Barra', receiptRef: '99812' })).toBe('datáfono Barra sin comprobar con Paytef · operación 99812');
  });

  it('quién la puede liberar y los errores, en una frase', () => {
    expect(releaseBlockText(null)).toBeNull();
    expect(releaseBlockText('not_owner')).toMatch(/Solo el dueño/);
    expect(releaseBlockText('own_sale')).toMatch(/otro dueño/);
    expect(releaseErrorText({ code: 'BANK_RELEASE_OWN_SALE' })).toMatch(/otro dueño/);
    expect(releaseErrorText({ code: 'BANK_HOLD_NONE' })).toMatch(/ya no está retenida/);
    expect(releaseErrorText({ code: 'TOTP_INVALID', message: 'El código no es correcto.' })).toBe('El código no es correcto.');
    expect(releaseErrorText(null)).toMatch(/No se ha podido liberar/);
  });

  it('la confirmación dice qué se da por cobrado y cuánto entra en su próximo pago', () => {
    expect(releaseConfirmText({ ref: 'C-0012', chargedCents: 20_000, shareCents: 18_000 }, 'Ana')).toBe(
      `Doy por cobrada la venta C-0012 de ${formatEur(20_000)} sin el cuadre del banco: ${formatEur(18_000)} de Ana entran en su próximo pago.`,
    );
  });
});
