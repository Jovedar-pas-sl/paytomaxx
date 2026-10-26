import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { GoneException, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
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

describe('POST /payments/public/:token/start-authorization — retirado (DIN-2)', () => {
  it('responde 410 Gone sin tocar el cobro: el pago va por POST /pay/:token (propina, idioma, método)', () => {
    const startAuthorization = vi.fn();
    const controller = new PaymentsController({ startAuthorization } as never);
    let thrown: unknown;
    try {
      controller.startAuthorization('qr-token-de-un-cobro');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GoneException);
    expect((thrown as GoneException).getStatus()).toBe(410);
    expect(JSON.stringify((thrown as GoneException).getResponse())).toContain('/pay/');
    expect(startAuthorization).not.toHaveBeenCalled();
  });

  it('sigue siendo pública (sin sesión): a quien la llame le llega el 410, no un 401', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, PaymentsController.prototype.startAuthorization)).toBe(true);
  });
});
