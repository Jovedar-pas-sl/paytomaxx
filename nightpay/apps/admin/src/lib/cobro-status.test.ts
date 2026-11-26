import { describe, expect, it } from 'vitest';
import { detailStatus } from './cobro-detail-view';
import { cobroStatus } from './cobro-status';

describe('el estado de un cobro en las tablas del panel', () => {
  it('una palabra por estado, la misma con tarjeta y con el saldo', () => {
    expect(cobroStatus({ kind: 'PAYMENT', status: 'AUTHORIZED' } as never)).toEqual({ label: 'Pagado', tone: 'success' });
    expect(cobroStatus({ kind: 'SALDO', status: 'ACCEPTED' } as never)).toEqual({ label: 'Pagado', tone: 'success' });
    expect(cobroStatus({ kind: 'PAYMENT', status: 'CANCELED' } as never).label).toBe('Cancelado');
    expect(cobroStatus({ kind: 'PAYMENT', status: 'REFUNDED' } as never).label).toBe('Devuelto');
    expect(cobroStatus({ kind: 'SALDO', status: 'REVERSED' } as never).label).toBe('Anulado');
  });

  // Entrega 9 (idea 9): cada estado con su símbolo. Antes «esperando» era `info`
  // y lo devuelto `warning` o `neutral`: ahora tienen su tono propio (reloj y flecha de vuelta).
  it('nada de lima para un estado: esperando lleva su reloj, lo devuelto su flecha, rechazado en rojo', () => {
    expect(cobroStatus({ kind: 'PAYMENT', status: 'AUTHORIZING' } as never)).toEqual({ label: 'Esperando pago', tone: 'wait' });
    expect(cobroStatus({ kind: 'PAYMENT', status: 'AWAITING_CAPTURE' } as never)).toEqual({ label: 'En el datáfono', tone: 'wait' });
    expect(cobroStatus({ kind: 'PAYMENT', status: 'PARTIALLY_REFUNDED' } as never)).toEqual({ label: 'Devuelto en parte', tone: 'refund' });
    expect(cobroStatus({ kind: 'PAYMENT', status: 'REFUNDED' } as never)).toEqual({ label: 'Devuelto', tone: 'refund' });
    expect(cobroStatus({ kind: 'PAYMENT', status: 'ORPHAN' } as never)).toEqual({ label: 'Sin confirmar', tone: 'warning' });
    expect(cobroStatus({ kind: 'PAYMENT', status: 'FAILED' } as never)).toEqual({ label: 'Rechazado', tone: 'danger' });
  });

  it('el resto, neutro: cancelado, caducado, sin pagar y el saldo anulado', () => {
    for (const status of ['CANCELED', 'EXPIRED', 'CREATED']) expect(cobroStatus({ kind: 'PAYMENT', status } as never).tone, status).toBe('neutral');
    expect(cobroStatus({ kind: 'SALDO', status: 'REVERSED' } as never).tone).toBe('neutral');
  });

  it('en el detalle, el saldo anulado sale «Devuelto» con el tono de lo devuelto', () => {
    expect(detailStatus({ kind: 'SALDO', status: 'REVERSED' })).toEqual({ label: 'Devuelto', tone: 'refund' });
  });

  it('un estado nuevo que el panel no conoce sale tal cual, sin romper', () => {
    expect(cobroStatus({ kind: 'PAYMENT', status: 'NUEVO' } as never)).toEqual({ label: 'NUEVO', tone: 'neutral' });
  });
});
