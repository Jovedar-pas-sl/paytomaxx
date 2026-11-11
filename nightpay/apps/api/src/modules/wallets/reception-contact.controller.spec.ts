import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ReceptionContactController } from './reception-contact.controller';

describe('buscar un saldo por el teléfono (encargado o dueño)', () => {
  it('POST con el teléfono en el cuerpo, no en la URL (así no acaba en los logs)', async () => {
    const proto = ReceptionContactController.prototype;
    expect(Reflect.getMetadata(METHOD_METADATA, proto.byPhone)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, proto.byPhone)).toBe('wallets/by-phone');
    const contacts = { findByPhone: vi.fn(async () => []) };
    const controller = new ReceptionContactController(contacts as never);
    await controller.byPhone({ sub: 'u-1', role: 'OWNER', tenantId: 't-1' } as never, { phone: '600123456' });
    expect(contacts.findByPhone).toHaveBeenCalledWith({ userId: 'u-1', role: 'OWNER', tenantId: 't-1' }, '600123456');
  });
});
