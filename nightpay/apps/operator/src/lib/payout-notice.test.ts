import { describe, expect, it } from 'vitest';
import { payoutNoticeText } from './payout-notice';

const AT = '2026-11-19T22:10:00.000Z';

describe('aviso «Tu cuenta de cobro ha cambiado» al entrar en la app', () => {
  it('con cuenta: cuándo (hora de Madrid), a dónde le pagan ahora (tapada) y qué hacer si no fue ella', () => {
    expect(payoutNoticeText({ changedAt: AT, method: 'SEPA_IBAN', masked: 'ES79 •••• •••• 6789' })).toEqual({
      title: 'Tu cuenta de cobro ha cambiado',
      when: 'El 19 de noviembre a las 23:10.',
      now: 'Ahora te pagan a: Transferencia · ES79 •••• •••• 6789.',
      advice: 'Si no lo has pedido tú, habla hoy mismo con el dueño del local.',
    });
  });

  it('en efectivo o sin cuenta lo dice así', () => {
    expect(payoutNoticeText({ changedAt: AT, method: 'MANUAL_CASH', masked: null }).now).toBe('Ahora cobras en efectivo.');
    expect(payoutNoticeText({ changedAt: AT, method: null, masked: null }).now).toBe(
      'Ya no tienes cuenta de cobro: hasta que pongas otra, se te paga en efectivo.',
    );
  });
});
