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

  it('esperando al banco: cuándo salió el intento (la espera se cuenta desde ahí); un API viejo, sin él', () => {
    expect(pollUpdate({ status: 'AUTHORIZING', attemptStartedAt: '2026-10-14T00:00:05.000Z' }, ID)).toEqual({
      status: 'AUTHORIZING',
      attemptStartedAt: '2026-10-14T00:00:05.000Z',
      bitcoin: null,
    });
    expect(pollUpdate({ status: 'ORPHAN', attemptStartedAt: '2026-10-14T00:00:05.000Z' }, ID)).toMatchObject({ attemptStartedAt: '2026-10-14T00:00:05.000Z' });
    expect(pollUpdate({ status: 'AUTHORIZING' }, ID)).not.toHaveProperty('attemptStartedAt');
  });

  it('un API viejo (sin propina) no la inventa: propina desconocida, no 0', () => {
    expect(pollUpdate({ id: ID, status: 'AUTHORIZED' }, ID)).toEqual({ status: 'AUTHORIZED' });
    expect(pollUpdate({ id: ID, status: 'AUTHORIZED' }, ID)).not.toHaveProperty('tipCents');
  });

  it('la respuesta de otro cobro no cuenta', () => {
    expect(pollUpdate({ id: 'otro', status: 'AUTHORIZED', tipCents: 200 }, ID)).toBeNull();
  });

  it('sin pagar, el API ya no da el id (de él sale el código del «Pagado»): la respuesta de su QR vale', () => {
    expect(pollUpdate({ status: 'AUTHORIZING' }, ID)).toEqual({ status: 'AUTHORIZING', bitcoin: null });
    expect(pollUpdate({ status: 'FAILED' }, ID)).toEqual({ status: 'FAILED' });
  });

  it('pagando con bitcoin: el estado de su factura (open, confirming, problem); con tarjeta (o un API viejo), null', () => {
    expect(pollUpdate({ status: 'AUTHORIZING', bitcoin: 'open' }, ID)).toEqual({ status: 'AUTHORIZING', bitcoin: 'open' });
    expect(pollUpdate({ status: 'AUTHORIZING', bitcoin: 'confirming' }, ID)).toMatchObject({ bitcoin: 'confirming' });
    expect(pollUpdate({ status: 'AUTHORIZING', bitcoin: 'problem' }, ID)).toMatchObject({ bitcoin: 'problem' });
    expect(pollUpdate({ status: 'AUTHORIZING' }, ID)).toMatchObject({ bitcoin: null });
    // Un valor que no se conoce no abre la puerta a cancelar.
    expect(pollUpdate({ status: 'AUTHORIZING', bitcoin: 'otra-cosa' as never }, ID)).toMatchObject({ bitcoin: null });
  });

  it('fuera de AUTHORIZING el sondeo no dice nada de bitcoin (no pisa lo que se sabe)', () => {
    expect(pollUpdate({ status: 'AWAITING_CAPTURE' }, ID)).not.toHaveProperty('bitcoin');
    expect(pollUpdate({ id: ID, status: 'AUTHORIZED', tipCents: 0 }, ID)).not.toHaveProperty('bitcoin');
  });

  it('salvo «closed»: la factura de bitcoin se cerró sin pagarse y el cobro vuelve a estar abierto', () => {
    expect(pollUpdate({ status: 'AWAITING_CAPTURE', bitcoin: 'closed' }, ID)).toEqual({ status: 'AWAITING_CAPTURE', bitcoin: 'closed' });
  });
});
