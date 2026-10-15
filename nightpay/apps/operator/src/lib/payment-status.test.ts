import { describe, expect, it } from 'vitest';
import { advanceStatus, isFinalStatus } from './payment-status';

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
