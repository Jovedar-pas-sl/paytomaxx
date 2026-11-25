import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { GoneException, ParseUUIDPipe } from '@nestjs/common';
import { HEADERS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CreatePaymentSchema } from '@nightpay/contracts';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { IP_RATE_LIMIT_META, type IpRateLimitConfig } from '../../common/guards/ip-rate-limit.guard';
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

describe('POST /payments: el cobro va en euros (punto 72)', () => {
  const body = { amountCents: 5_000, terminalExternalId: 'BARRA-1' };

  it('otra moneda no pasa (400): el banco cobraría euros y el cobro no quedaría nunca pagado', () => {
    expect(CreatePaymentSchema.safeParse({ ...body, currency: 'XYZ' }).success).toBe(false);
    expect(CreatePaymentSchema.safeParse({ ...body, currency: 'USD' }).success).toBe(false);
  });

  it('EUR, o sin moneda (queda EUR), como mandan las apps', () => {
    expect(CreatePaymentSchema.parse({ ...body, currency: 'EUR' }).currency).toBe('EUR');
    expect(CreatePaymentSchema.parse(body).currency).toBe('EUR');
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
    const controller = new PaymentsController({ startAuthorization } as never, {} as never);
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

describe('GET /payments/public/:token: el estado vivo de un cobro', () => {
  it('no se guarda en caché (ni navegador ni proxy del local): Cache-Control: no-store', () => {
    const headers = Reflect.getMetadata(HEADERS_METADATA, PaymentsController.prototype.getPublic) as Array<{
      name: string;
      value: string;
    }>;
    expect(headers).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
  });

  it('lo sondean las apps del personal sin sesión desde el wifi del local: cada cobro con su cupo y la IP con un tope alto', () => {
    const limit = Reflect.getMetadata(IP_RATE_LIMIT_META, PaymentsController.prototype.getPublic) as IpRateLimitConfig;
    expect(limit).toMatchObject({ windowSec: 60, scope: 'payment-public', failOpen: true, perKey: { param: 'token', max: 60 } });
    // Cientos de cobros abiertos a la vez (cada 4-10 s cada uno) caben; un barrido de tokens, no sin fin.
    expect(limit.max).toBeGreaterThanOrEqual(3_000);
  });
});
