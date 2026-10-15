import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PaymentsController } from './payments.controller';
import { TerminalsController } from '../terminals/terminals.controller';

/** Pipes del parámetro :id de una ruta (los que Nest aplica antes del handler). */
function idPipes(controller: object, method: string): unknown[] {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<
    string,
    { data?: unknown; pipes?: unknown[] }
  >;
  return Object.values(args).find((a) => a.data === 'id')?.pipes ?? [];
}

describe('rutas con :id — un id que no es UUID da 400, no un 500 de Postgres (#61)', () => {
  it.each(['findOne', 'confirmPos', 'cancel'])('payments.%s', (method) => {
    expect(idPipes(PaymentsController, method)).toContain(ParseUUIDPipe);
  });

  it('PATCH /terminals/:id', () => {
    expect(idPipes(TerminalsController, 'update')).toContain(ParseUUIDPipe);
  });
});

describe('cancelar un cobro: roles', () => {
  it('el camarero también (solo los suyos: lo comprueba el servicio)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, PaymentsController.prototype.cancel) as string[];
    expect(roles).toEqual(['OWNER', 'MANAGER', 'OPERATOR', 'WAITER']);
  });
});
