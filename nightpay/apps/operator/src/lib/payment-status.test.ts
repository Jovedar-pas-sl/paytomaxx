import { describe, expect, it } from 'vitest';
import { advanceStatus, isFinalStatus, pollUpdate } from './payment-status';

describe('estado del cobro en la pantalla de la chica', () => {
  it('avanza con lo que digan el socket o el sondeo', () => {
    expect(advanceStatus(null, 'CREATED')).toBe('CREATED');
    expect(advanceStatus('CREATED', 'AWAITING_CAPTURE')).toBe('AWAITING_CAPTURE');
    expect(advanceStatus('AUTHORIZING', 'AUTHORIZED')).toBe('AUTHORIZED');
    expect(advanceStatus('ORPHAN', 'FAILED')).toBe('FAILED');
  });

  it('una respuesta que llega tarde no la hace retroceder («Pagado» no vuelve a «Esperando»)', () => {
    expect(advanceStatus('AUTHORIZED', 'AWAITING_CAPTURE')).toBe('AUTHORIZED');
    expect(advanceStatus('AUTHORIZING', 'CREATED')).toBe('AUTHORIZING');
    expect(advanceStatus('CANCELED', 'CREATED')).toBe('CANCELED');
  });

  it('estados finales: se deja de preguntar', () => {
    for (const s of ['AUTHORIZED', 'FAILED', 'EXPIRED', 'CANCELED', 'REFUNDED'] as const) {
      expect(isFinalStatus(s)).toBe(true);
    }
    for (const s of ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING', 'ORPHAN'] as const) {
      expect(isFinalStatus(s)).toBe(false);
    }
  });
});

describe('el sondeo de respaldo (sin tiempo real)', () => {
  const ID = 'pay-1';

  it('trae la propina del cliente cuando el API la da (pagado): el PAGADO no se queda sin ella', () => {
    expect(pollUpdate({ id: ID, status: 'AUTHORIZED', tipCents: 200 }, ID)).toEqual({ status: 'AUTHORIZED', tipCents: 200 });
    expect(pollUpdate({ id: ID, status: 'AUTHORIZED', tipCents: 0 }, ID)).toEqual({ status: 'AUTHORIZED', tipCents: 0 });
  });

  it('un API viejo (sin propina) no la inventa: propina desconocida, no 0', () => {
    expect(pollUpdate({ id: ID, status: 'AUTHORIZED' }, ID)).toEqual({ status: 'AUTHORIZED' });
    expect(pollUpdate({ id: ID, status: 'AUTHORIZED' }, ID)).not.toHaveProperty('tipCents');
  });

  it('la respuesta de otro cobro no cuenta', () => {
    expect(pollUpdate({ id: 'otro', status: 'AUTHORIZED', tipCents: 200 }, ID)).toBeNull();
  });
});
