import { describe, expect, it } from 'vitest';
import { arrivedTooLate, cancelTargetOf } from './cobro-attempt';

describe('un cobro de invitación que llega cuando ya se salió de su pantalla', () => {
  it('se descarta si se pidió en otra pantalla (se pulsó «Atrás» mientras se creaba)', () => {
    expect(arrivedTooLate({ invitation: true, screen: 3 }, 4)).toBe(true);
    expect(arrivedTooLate({ invitation: true, screen: 3 }, 3)).toBe(false);
  });

  it('la cuenta, como siempre: se abre «Esperando» (se puede cancelar allí)', () => {
    expect(arrivedTooLate({ invitation: false, screen: 3 }, 4)).toBe(false);
  });

  it('se cancela el de tarjeta (con su saldo enlazado) o, sin tarjeta, el del saldo', () => {
    expect(cancelTargetOf({ card: { id: 'p-1' }, saldo: { chargeId: 'w-1' } })).toEqual({ kind: 'card', id: 'p-1' });
    expect(cancelTargetOf({ card: null, saldo: { chargeId: 'w-1' } })).toEqual({ kind: 'saldo', id: 'w-1' });
    expect(cancelTargetOf({ card: null, saldo: null })).toBeNull();
  });
});
