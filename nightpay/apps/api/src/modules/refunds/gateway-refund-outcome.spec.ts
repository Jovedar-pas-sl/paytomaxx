import { describe, it, expect } from 'vitest';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { outcomeOfGatewayError, outcomeOfGatewayResult } from './gateway-refund-outcome';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('outcomeOfGatewayResult — lo que contesta la pasarela', () => {
  it('SUCCEEDED → hecha', () => {
    expect(outcomeOfGatewayResult({ providerRefundId: 'R-1', status: 'SUCCEEDED' })).toEqual({
      kind: 'succeeded',
      providerRefundId: 'R-1',
    });
  });

  it('FAILED → rechazada por la pasarela (no se movió dinero)', () => {
    expect(outcomeOfGatewayResult({ providerRefundId: 'R-2', status: 'FAILED' })).toMatchObject({
      kind: 'rejected',
      why: 'declined',
      providerRefundId: 'R-2',
    });
  });

  it('PENDING → no sabemos aún si se hará: queda pendiente', () => {
    expect(outcomeOfGatewayResult({ providerRefundId: 'R-3', status: 'PENDING' })).toMatchObject({
      kind: 'unknown',
      providerRefundId: 'R-3',
    });
  });
});

describe('outcomeOfGatewayError — solo FAILED si seguro que no se hizo', () => {
  it('la pasarela no devuelve por API (mensajes de los adaptadores) → rechazada, sin pendiente', () => {
    const messages = [
      'Cecabank refund vía API no implementado en este sprint. Refundea manualmente desde https://comercios.ceca.es',
      'peanpe-refund-manual-required: Peanpe v2.0 no expone refund por API.',
      'paytef-refund-manual-required: Paytef PaymentLINK no expone refund via API.',
      'Redsys refund vía API no implementado. Refundea manualmente desde el panel del banco.',
    ];
    for (const m of messages) {
      expect(outcomeOfGatewayError(new Error(m))).toMatchObject({ kind: 'rejected', why: 'unsupported' });
    }
  });

  it('circuito abierto / semáforo / apagado → la llamada ni salió → rechazada', () => {
    for (const code of ['EOPENBREAKER', 'ESEMLOCKED', 'ESHUTDOWN']) {
      expect(outcomeOfGatewayError(withCode('Breaker is open', code))).toMatchObject({
        kind: 'rejected',
        why: 'not_sent',
      });
    }
  });

  it('sin conexión (rechazada, DNS, conectar) → no salió → rechazada; también dentro de `cause` (fetch)', () => {
    expect(outcomeOfGatewayError(withCode('connect ECONNREFUSED', 'ECONNREFUSED'))).toMatchObject({
      kind: 'rejected',
      why: 'not_sent',
    });
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: withCode('getaddrinfo', 'ENOTFOUND') });
    expect(outcomeOfGatewayError(fetchFailed)).toMatchObject({ kind: 'rejected', why: 'not_sent' });
  });

  it('4xx explícito de la pasarela → rechazada; 408 y 409 no (pudo hacerse)', () => {
    expect(outcomeOfGatewayError(new BadRequestException('importe no válido'))).toMatchObject({
      kind: 'rejected',
      why: 'declined',
    });
    expect(outcomeOfGatewayError(Object.assign(new Error('x'), { response: { status: 422 } }))).toMatchObject({
      kind: 'rejected',
    });
    expect(outcomeOfGatewayError(new ConflictException('ya devuelta'))).toMatchObject({ kind: 'unknown' });
    expect(outcomeOfGatewayError(Object.assign(new Error('x'), { status: 408 }))).toMatchObject({ kind: 'unknown' });
  });

  it('timeout, conexión cortada, 5xx o error desconocido → no sabemos: queda pendiente', () => {
    expect(outcomeOfGatewayError(withCode('Timed out after 10000ms', 'ETIMEDOUT'))).toMatchObject({ kind: 'unknown' });
    expect(outcomeOfGatewayError(withCode('socket hang up', 'ECONNRESET'))).toMatchObject({ kind: 'unknown' });
    expect(outcomeOfGatewayError(new ServiceUnavailableException('PSP caído'))).toMatchObject({ kind: 'unknown' });
    expect(outcomeOfGatewayError(new Error('algo raro'))).toMatchObject({ kind: 'unknown' });
    expect(outcomeOfGatewayError('texto suelto')).toMatchObject({ kind: 'unknown' });
  });

  it('guarda el motivo para la incidencia', () => {
    expect(outcomeOfGatewayError(withCode('Timed out after 10000ms', 'ETIMEDOUT'))).toMatchObject({
      reason: 'Timed out after 10000ms',
    });
  });
});
