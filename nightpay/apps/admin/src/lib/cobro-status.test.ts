import { describe, expect, it } from 'vitest';
import { cobroStatus } from './cobro-status';

describe('el estado de un cobro en las tablas del panel', () => {
  it('una palabra por estado, la misma con tarjeta y con el saldo', () => {
    expect(cobroStatus({ kind: 'PAYMENT', status: 'AUTHORIZED' } as never)).toEqual({ label: 'Pagado', tone: 'success' });
    expect(cobroStatus({ kind: 'SALDO', status: 'ACCEPTED' } as never)).toEqual({ label: 'Pagado', tone: 'success' });
    expect(cobroStatus({ kind: 'PAYMENT', status: 'CANCELED' } as never).label).toBe('Cancelado');
    expect(cobroStatus({ kind: 'PAYMENT', status: 'REFUNDED' } as never).label).toBe('Devuelto');
    expect(cobroStatus({ kind: 'SALDO', status: 'REVERSED' } as never).label).toBe('Anulado');
  });

  it('nada de lima para un estado: esperando es informativo (neutro), rechazado en rojo', () => {
    expect(cobroStatus({ kind: 'PAYMENT', status: 'AUTHORIZING' } as never).tone).toBe('info');
    expect(cobroStatus({ kind: 'PAYMENT', status: 'FAILED' } as never)).toEqual({ label: 'Rechazado', tone: 'danger' });
  });

  it('un estado nuevo que el panel no conoce sale tal cual, sin romper', () => {
    expect(cobroStatus({ kind: 'PAYMENT', status: 'NUEVO' } as never)).toEqual({ label: 'NUEVO', tone: 'neutral' });
  });
});
