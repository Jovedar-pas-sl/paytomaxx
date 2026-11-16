import { describe, it, expect } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { CANCEL_HELD_ON_READER_CODE, heldOnReaderConflict, isHeldOnReader } from './reader-hold';

describe('recarga cobrada en el datáfono sin comprobar', () => {
  it('es la de AUTHORIZING con la operación del datáfono (la marca de Resolver)', () => {
    expect(isHeldOnReader({ status: 'AUTHORIZING', posOperationNumber: '99812' })).toBe(true);
  });

  it('no lo es: el cliente en su banco o con bitcoin (sin operación), ni lo ya pagado o sin empezar', () => {
    expect(isHeldOnReader({ status: 'AUTHORIZING', posOperationNumber: null })).toBe(false);
    expect(isHeldOnReader({ status: 'AUTHORIZING' })).toBe(false);
    expect(isHeldOnReader({ status: 'AUTHORIZING', posOperationNumber: '' })).toBe(false);
    expect(isHeldOnReader({ status: 'AUTHORIZED', posOperationNumber: '99812' })).toBe(false);
    expect(isHeldOnReader({ status: 'CREATED', posOperationNumber: null })).toBe(false);
  });

  it('el 409: su código y quién lo resuelve', () => {
    const err = heldOnReaderConflict();
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({
      code: CANCEL_HELD_ON_READER_CODE,
      message: 'Cobrado en el datáfono: lo resuelve el encargado en Pagos → Resolver',
    });
    expect(CANCEL_HELD_ON_READER_CODE).toBe('CANCEL_HELD_ON_READER');
  });
});
