import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { JwtPayload, Role } from '@nightpay/contracts';
import { AdminController } from './admin.controller';
import { InvalidTransitionError } from '../payments/payment.machine';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';

/**
 * Resolución a mano de un cobro atascado (dinero): el dueño de Sala Bambú
 * (Madrid) lo marca cobrado con el código del banco o lo da por fallido.
 * Y el kill-switch de sesiones de un usuario del propio local.
 */

const SALA_BAMBU = '7d3f2a10-5b6c-4e8d-9f01-2a3b4c5d6e7f';
const OTRO_LOCAL = '91c0e4b2-3a5d-4f6e-8b7c-0d1e2f3a4b5c';
const PAGO = 'c4e1b7a9-2d3f-4a5b-9c6d-7e8f9a0b1c2d';
const OTRO_PAGO = 'e2d4f6a8-1b3c-4d5e-8f9a-0b1c2d3e4f5a';
const DUENO = { sub: '0b5e8c2a-6d4f-4e1a-9b3c-5d7e9f1a3b5c', tenantId: SALA_BAMBU, role: 'OWNER' } as unknown as JwtPayload;
// Sábado de madrugada en Madrid (CEST).
const AHORA = new Date('2026-10-17T01:30:00+02:00');
const MIN = 60_000;
const none = {} as never;

interface Pago {
  id: string;
  status: string;
  provider: string | null;
  providerTxId: string | null;
  tenantId: string;
  updatedAt: Date;
}
interface Intento {
  paymentId: string;
  providerTxId: string;
  tipCents: number | null;
  status: string;
  provider?: string;
}
type Body = Parameters<AdminController['manualReconcile']>[3];

function pago(overrides: Partial<Pago> = {}): Pago {
  return {
    id: PAGO,
    status: 'ORPHAN',
    provider: 'REDSYS',
    providerTxId: '2610AB12',
    tenantId: SALA_BAMBU,
    updatedAt: new Date(AHORA.getTime() - 40 * MIN),
    ...overrides,
  };
}

function montar(p: Pago | null, intentos: Intento[] = []) {
  const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const findMany = vi.fn(async (args: { where: { paymentId: string; status?: { not: string }; provider?: string } }) =>
    intentos
      .filter((a) => a.paymentId === args.where.paymentId && a.status !== args.where.status?.not)
      .filter((a) => !args.where.provider || (a.provider ?? 'REDSYS') === args.where.provider)
      .map(({ providerTxId, tipCents }) => ({ providerTxId, tipCents })),
  );
  const prisma = {
    payment: { findUnique: vi.fn(async () => p), updateMany },
    asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ paymentAttempt: { findMany } })),
  };
  const eventos: Array<Record<string, unknown>> = [];
  const payments = {
    transition: vi.fn(async (_id: string, ev: Record<string, unknown>) => {
      eventos.push(ev);
    }),
  };
  const audit = { log: vi.fn(async (_entry: Record<string, unknown>) => undefined) };
  const totp = { assertForUser: vi.fn(async (_user: string, _code: string | undefined) => undefined) };
  const ctrl = new AdminController(prisma as never, none, audit as never, none, payments as never, none, totp as never);
  const resolver = (body: Body, tenant = SALA_BAMBU) => ctrl.manualReconcile(PAGO, tenant, DUENO, body);
  return { resolver, eventos, payments, audit, updateMany, totp };
}

const COBRADO: Body = {
  decision: 'AUTHORIZED',
  reason: 'Visto en el portal de Redsys',
  bankAuthCode: '4F7K2Q',
  bankOrder: '2610AB12',
  totpCode: '123456',
};
const FALLIDO: Body = { decision: 'FAILED', reason: 'El banco no tiene ningún cargo' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AHORA);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('manualReconcile — quién y qué cobro se puede resolver', () => {
  it('cobro inexistente → NotFound y nada se escribe', async () => {
    const h = montar(null);
    await expect(h.resolver(COBRADO)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.payments.transition).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('cobro de otro local → Forbidden: ni transición, ni código, ni auditoría', async () => {
    const h = montar(pago({ tenantId: OTRO_LOCAL }));
    await expect(h.resolver(COBRADO)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.payments.transition).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it.each(['AUTHORIZED', 'FAILED', 'CREATED', 'REFUNDED', 'CANCELED'])(
    'estado %s → Conflict (solo ORPHAN o AUTHORIZING atascado)',
    async (status) => {
      const h = montar(pago({ status }));
      await expect(h.resolver(COBRADO)).rejects.toBeInstanceOf(ConflictException);
      expect(h.payments.transition).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    },
  );

  it('AUTHORIZING con 14 min sin aviso → Conflict (el aviso del banco aún puede llegar)', async () => {
    const h = montar(pago({ status: 'AUTHORIZING', updatedAt: new Date(AHORA.getTime() - 14 * MIN) }));
    await expect(h.resolver(COBRADO)).rejects.toThrow(/15 minutos/);
    expect(h.payments.transition).not.toHaveBeenCalled();
  });

  it('AUTHORIZING con 15 min justos → ya se puede marcar cobrado', async () => {
    const h = montar(pago({ status: 'AUTHORIZING', updatedAt: new Date(AHORA.getTime() - 15 * MIN) }));
    await expect(h.resolver(COBRADO)).resolves.toEqual({ ok: true, newStatus: 'AUTHORIZED' });
    expect(h.eventos).toEqual([{ type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: '2610AB12' }]);
  });

  it('recarga del datáfono sin la prueba de Paytef (con operación): se resuelve al momento, no espera aviso', async () => {
    const venta = { ...pago({ status: 'AUTHORIZING', provider: 'PAYTEF', providerTxId: '99812', updatedAt: new Date(AHORA.getTime() - MIN) }), posOperationNumber: '99812' };
    const h = montar(venta);
    const visto: Body = { decision: 'AUTHORIZED', reason: 'Visto en el panel de Paytef', bankAuthCode: '047215' };
    await expect(h.resolver(visto)).resolves.toEqual({ ok: true, newStatus: 'AUTHORIZED' });
    expect(h.eventos).toEqual([{ type: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: '99812' }]);
  });
});

describe('manualReconcile — darlo por cobrado pide el 2FA del dueño', () => {
  it('sin código válido no se marca nada; «No se cobró» no lo pide', async () => {
    const { resolver, eventos, totp } = montar(pago());
    totp.assertForUser.mockRejectedValueOnce(new ForbiddenException({ code: 'TOTP_REQUIRED' }));
    await expect(resolver({ ...COBRADO, totpCode: undefined })).rejects.toBeInstanceOf(ForbiddenException);
    expect(eventos).toEqual([]);
    await resolver(FALLIDO);
    expect(totp.assertForUser).toHaveBeenCalledTimes(1);
  });
});

describe('manualReconcile — marcar cobrado (AUTHORIZED)', () => {
  const intento = (providerTxId: string, tipCents: number | null, status = 'AUTHORIZING', paymentId = PAGO): Intento => ({
    paymentId,
    providerTxId,
    tipCents,
    status,
  });

  it('con el pedido cobrado: transición con ese pedido, apunta el código sin pisar y audita', async () => {
    const h = montar(pago({ providerTxId: '2610AB13' }), [intento('2610AB12', 500), intento('2610AB13', 0)]);
    await expect(h.resolver(COBRADO)).resolves.toEqual({ ok: true, newStatus: 'AUTHORIZED' });
    // El pedido elegido (no el último) fija la propina en transition().
    expect(h.eventos).toEqual([{ type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: '2610AB12' }]);
    expect(h.updateMany).toHaveBeenCalledWith({ where: { id: PAGO, authCode: null }, data: { authCode: '4F7K2Q' } });
    expect(h.audit.log).toHaveBeenCalledWith({
      action: 'payment.manual_reconcile',
      tenantId: SALA_BAMBU,
      actorId: DUENO.sub,
      targetType: 'Payment',
      targetId: PAGO,
      payload: {
        decision: 'AUTHORIZED',
        reason: 'Visto en el portal de Redsys',
        bankAuthCode: '4F7K2Q',
        bankOrder: '2610AB12',
        fromStatus: 'ORPHAN',
      },
    });
  });

  it('sin pedido y todos los intentos con la misma propina → usa el pedido del cobro', async () => {
    const h = montar(pago(), [intento('2610AB11', 300), intento('2610AB12', 300)]);
    await h.resolver({ ...COBRADO, bankOrder: undefined });
    expect(h.eventos).toEqual([{ type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: '2610AB12' }]);
    expect(h.audit.log.mock.calls[0]?.[0]).toMatchObject({ payload: { bankOrder: null } });
  });

  it('sin pedido e intentos con propinas distintas → BadRequest: hay que elegir el pedido', async () => {
    const h = montar(pago(), [intento('2610AB11', 0), intento('2610AB12', 500)]);
    await expect(h.resolver({ ...COBRADO, bankOrder: undefined })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.payments.transition).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('los intentos denegados no cuentan para la propina', async () => {
    const h = montar(pago(), [intento('2610AB11', 0, 'DENIED'), intento('2610AB12', 500)]);
    await expect(h.resolver({ ...COBRADO, bankOrder: undefined })).resolves.toMatchObject({ ok: true });
    expect(h.eventos).toEqual([{ type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: '2610AB12' }]);
  });

  it('pedido de OTRO cobro → BadRequest, aunque exista en el banco', async () => {
    const h = montar(pago(), [intento('2610AB12', 500), intento('2610ZZ99', 0, 'AUTHORIZING', OTRO_PAGO)]);
    await expect(h.resolver({ ...COBRADO, bankOrder: '2610ZZ99' })).rejects.toThrow(/pedido no es de este cobro/);
    expect(h.payments.transition).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('pedido de un intento denegado de este cobro → BadRequest', async () => {
    const h = montar(pago(), [intento('2610AB11', 500, 'DENIED'), intento('2610AB12', 0)]);
    await expect(h.resolver({ ...COBRADO, bankOrder: '2610AB11' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.payments.transition).not.toHaveBeenCalled();
  });

  it('cobro sin intentos (anterior a la Fase 0) y sin pedido → se resuelve con su pedido', async () => {
    const h = montar(pago());
    await h.resolver({ ...COBRADO, bankOrder: undefined });
    expect(h.eventos).toEqual([{ type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: '2610AB12' }]);
  });

  // Antes, sin intentos no se comprobaba el pedido y pasaba a ser el del cobro:
  // devoluciones y cuadre apuntaban al cargo de otro cobro.
  it('cobro sin intentos con un pedido distinto al suyo → BadRequest', async () => {
    const h = montar(pago());
    await expect(h.resolver({ ...COBRADO, bankOrder: '2610ZZ99' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.payments.transition).not.toHaveBeenCalled();
  });

  it('cobro sin intentos con su mismo pedido → se resuelve', async () => {
    const h = montar(pago());
    await h.resolver({ ...COBRADO, bankOrder: '2610AB12' });
    expect(h.eventos).toEqual([{ type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: '2610AB12' }]);
  });

  it('solo intentos denegados y un pedido que no es el del cobro → BadRequest', async () => {
    const h = montar(pago(), [intento('2610AB11', 500, 'DENIED')]);
    await expect(h.resolver({ ...COBRADO, bankOrder: '2610AB11' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.payments.transition).not.toHaveBeenCalled();
  });

  it('cobro sin provider/providerTxId → Conflict y no se toca', async () => {
    const h = montar(pago({ provider: null, providerTxId: null }));
    await expect(h.resolver(COBRADO)).rejects.toBeInstanceOf(ConflictException);
    expect(h.payments.transition).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('si el estado cambió a la vez (InvalidTransitionError) → Conflict y sin auditoría', async () => {
    const h = montar(pago());
    h.payments.transition.mockRejectedValueOnce(new InvalidTransitionError('AUTHORIZED', 'AUTHORIZED'));
    await expect(h.resolver(COBRADO)).rejects.toThrow(ConflictException);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('otro error de la transición se propaga tal cual', async () => {
    const h = montar(pago());
    const caida = new Error('conexión perdida con Postgres');
    h.payments.transition.mockRejectedValueOnce(caida);
    await expect(h.resolver(COBRADO)).rejects.toBe(caida);
    expect(h.audit.log).not.toHaveBeenCalled();
  });
});

describe('manualReconcile — dar por fallido (FAILED)', () => {
  it('desde ORPHAN: una sola transición FAILED con el motivo; no apunta código', async () => {
    const h = montar(pago());
    await expect(h.resolver({ ...FALLIDO, bankAuthCode: '4F7K2Q' })).resolves.toEqual({ ok: true, newStatus: 'FAILED' });
    expect(h.eventos).toEqual([{ type: 'FAILED', reason: 'manual-reconcile: El banco no tiene ningún cargo' }]);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.audit.log.mock.calls[0]?.[0]).toMatchObject({
      action: 'payment.manual_reconcile',
      payload: { decision: 'FAILED', bankAuthCode: null, bankOrder: null, fromStatus: 'ORPHAN' },
    });
  });

  it('desde AUTHORIZING atascado: primero TIMEOUT (→ ORPHAN) y luego FAILED', async () => {
    const h = montar(pago({ status: 'AUTHORIZING', updatedAt: new Date(AHORA.getTime() - 20 * MIN) }));
    await h.resolver(FALLIDO);
    expect(h.eventos.map((e) => e.type)).toEqual(['TIMEOUT', 'FAILED']);
    expect(h.audit.log.mock.calls[0]?.[0]).toMatchObject({ payload: { fromStatus: 'AUTHORIZING' } });
  });
});

describe('manualReconcile — validación del cuerpo (ZodValidationPipe de la ruta)', () => {
  function pipeDelCuerpo(): ZodValidationPipe<never> {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminController, 'manualReconcile') as Record<
      string,
      { pipes?: unknown[] }
    >;
    const pipe = Object.values(args)
      .flatMap((a) => a.pipes ?? [])
      .find((p): p is ZodValidationPipe<never> => p instanceof ZodValidationPipe);
    if (!pipe) throw new Error('manualReconcile sin ZodValidationPipe en el cuerpo');
    return pipe;
  }
  const validar = (body: unknown) => pipeDelCuerpo().transform(body) as unknown;

  it('normaliza el código del banco: espacios fuera y en mayúsculas', () => {
    expect(validar({ decision: 'AUTHORIZED', reason: 'Portal Redsys', bankAuthCode: ' 4f7 k2q ' })).toMatchObject({
      bankAuthCode: '4F7K2Q',
    });
  });

  it.each([
    ['AUTHORIZED sin código del banco', { decision: 'AUTHORIZED', reason: 'Portal Redsys' }],
    ['código de 5 caracteres', { decision: 'AUTHORIZED', reason: 'Portal Redsys', bankAuthCode: '4F7K2' }],
    ['código con símbolos', { decision: 'AUTHORIZED', reason: 'Portal Redsys', bankAuthCode: '4F7-2Q' }],
    ['pedido con guiones', { decision: 'AUTHORIZED', reason: 'Portal Redsys', bankAuthCode: '4F7K2Q', bankOrder: '26-10-AB' }],
    ['motivo de 2 letras', { decision: 'FAILED', reason: 'no' }],
    ['decisión inventada', { decision: 'REFUNDED', reason: 'Portal Redsys' }],
  ])('rechaza: %s', (_caso, body) => {
    expect(() => validar(body)).toThrow(BadRequestException);
  });

  it('FAILED no necesita código del banco', () => {
    expect(validar({ decision: 'FAILED', reason: 'Sin cargo en el banco' })).toEqual({
      decision: 'FAILED',
      reason: 'Sin cargo en el banco',
    });
  });
});

describe('manualReconcile — cobro con bitcoin (BTCPay): el id de su factura, no el código del banco', () => {
  const FACTURA = 'Kd8sY5DN6jLHfQfqHkFBnQ';
  const atascado = () => pago({ status: 'AUTHORIZING', provider: 'BTCPAY', providerTxId: FACTURA, updatedAt: new Date(AHORA.getTime() - 20 * MIN) });
  const intento = { paymentId: PAGO, providerTxId: FACTURA, tipCents: 0, status: 'PENDING', provider: 'BTCPAY' };
  const conFactura = (ref: string): Body => ({ decision: 'AUTHORIZED', reason: 'Factura pagada en BTCPay', btcpayInvoiceRef: ref, totpCode: '123456' });

  it('un trozo del id de la factura vale: queda pagado con esa factura, sin código del banco, y se audita', async () => {
    const h = montar(atascado(), [intento]);
    await expect(h.resolver(conFactura('fqhkfb'))).resolves.toEqual({ ok: true, newStatus: 'AUTHORIZED' });
    expect(h.eventos).toEqual([{ type: 'AUTHORIZED', provider: 'BTCPAY', providerTxId: FACTURA }]);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.audit.log.mock.calls[0]![0]).toMatchObject({ payload: { btcpayInvoiceId: FACTURA, bankAuthCode: null } });
  });

  it('el código del banco no sirve con bitcoin; otra factura tampoco: 400 diciendo dónde mirarlo, sin gastar el 2FA', async () => {
    const h = montar(atascado(), [intento]);
    await expect(h.resolver({ ...COBRADO, bankOrder: undefined })).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.resolver(conFactura('ZZZZZZZZ'))).rejects.toThrow(/BTCPay/);
    expect(h.totp.assertForUser).not.toHaveBeenCalled();
    expect(h.payments.transition).not.toHaveBeenCalled();
  });

  it('con el banco, el id de una factura no sustituye a su código', async () => {
    const h = montar(pago());
    await expect(h.resolver(conFactura('2610AB12'))).rejects.toThrow(/código de autorización del banco/);
    expect(h.payments.transition).not.toHaveBeenCalled();
  });
});

describe('revokeUserSessions — kill-switch de sesiones del propio local', () => {
  const ENCARGADO = '5a7c9e1b-3d5f-4a7b-8c9d-1e3f5a7b9c1d';

  function montarRevocar(usuario: { id: string; email: string; tenantId: string } | null) {
    const refreshTokens = { revokeAllForUser: vi.fn(async (_userId: string) => 3) };
    const audit = { log: vi.fn(async (_entry: Record<string, unknown>) => undefined) };
    const cls = { get: vi.fn(() => ({ userId: DUENO.sub })) };
    const prisma = { user: { findUnique: vi.fn(async () => usuario) } };
    const ctrl = new AdminController(prisma as never, refreshTokens as never, audit as never, none, none, cls as never, none);
    return { ctrl, refreshTokens, audit };
  }

  it('usuario del mismo local: revoca todas sus sesiones y lo audita', async () => {
    const h = montarRevocar({ id: ENCARGADO, email: 'encargado@salabambu.es', tenantId: SALA_BAMBU });
    await expect(h.ctrl.revokeUserSessions(SALA_BAMBU, ENCARGADO)).resolves.toEqual({ revoked: 3, userId: ENCARGADO });
    expect(h.refreshTokens.revokeAllForUser).toHaveBeenCalledWith(ENCARGADO);
    expect(h.audit.log).toHaveBeenCalledWith({
      action: 'auth.sessions.revoked',
      tenantId: SALA_BAMBU,
      actorId: DUENO.sub,
      targetType: 'User',
      targetId: ENCARGADO,
      payload: { revokedCount: 3, targetEmail: 'encargado@salabambu.es' },
    });
  });

  it('usuario de otro local → NotFound (no se revela) y no se revoca nada', async () => {
    const h = montarRevocar({ id: ENCARGADO, email: 'encargado@lunavlc.es', tenantId: OTRO_LOCAL });
    await expect(h.ctrl.revokeUserSessions(SALA_BAMBU, ENCARGADO)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('usuario inexistente → NotFound', async () => {
    const h = montarRevocar(null);
    await expect(h.ctrl.revokeUserSessions(SALA_BAMBU, ENCARGADO)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
  });
});

describe('matriz de roles de los endpoints sensibles de admin (solo OWNER)', () => {
  const SOLO_DUENO = ['manualReconcile', 'resetPassword', 'revokeUserSessions', 'updateVenueSettings'] as const;
  const reflector = new Reflector();
  const handler = (name: (typeof SOLO_DUENO)[number]) => AdminController.prototype[name];

  function contexto(name: (typeof SOLO_DUENO)[number], role: Role): ExecutionContext {
    const user = { sub: DUENO.sub, tenantId: SALA_BAMBU, role };
    return {
      getHandler: () => handler(name),
      getClass: () => AdminController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  it.each(SOLO_DUENO)('%s exige exactamente OWNER', (name) => {
    expect(reflector.get<Role[]>(ROLES_KEY, handler(name))).toEqual(['OWNER']);
  });

  it.each(SOLO_DUENO)('%s: RolesGuard deja pasar al OWNER y rechaza a MANAGER y OPERATOR', (name) => {
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(contexto(name, 'OWNER'))).toBe(true);
    expect(() => guard.canActivate(contexto(name, 'MANAGER'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contexto(name, 'OPERATOR'))).toThrow(ForbiddenException);
  });
});
