import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { JwtPayload } from '@nightpay/contracts';
import { IdempotencyKey } from './idempotent.decorator';
import { Tenant } from './tenant.decorator';
import { CurrentUser } from './current-user.decorator';
import { IS_PUBLIC_KEY, Public } from './public.decorator';
import { ROLES_KEY, Roles } from './roles.decorator';

type Factory = (data: unknown, ctx: ExecutionContext) => unknown;

/** La función que Nest ejecuta para un decorador de parámetro (createParamDecorator). */
function factoryOf(decorator: () => ParameterDecorator): Factory {
  class Dummy {
    handler(): void {}
  }
  decorator()(Dummy.prototype, 'handler', 0);
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Dummy, 'handler') as Record<string, { factory: Factory }>;
  const entry = Object.values(meta)[0];
  if (!entry) throw new Error('sin metadatos de parámetro');
  return entry.factory;
}

function ctx(req: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

const TENANT = '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01';
const OTRO_TENANT = 'b7e1d2c3-0000-4000-8000-00000000beef';
const USER: JwtPayload = {
  sub: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  email: 'camarera@sala-luna.es',
  role: 'WAITER',
  tenantId: TENANT,
  venueSlug: 'luna',
};

describe('@IdempotencyKey', () => {
  const idem = factoryOf(IdempotencyKey);
  const run = (value: string | string[] | undefined) => idem(undefined, ctx({ headers: { 'idempotency-key': value } }));

  it('devuelve la clave tal cual (UUID, base64url, con guiones bajos)', () => {
    expect(run('5f1c9a7e-2b3d-4e8f-9a01-23456789abcd')).toBe('5f1c9a7e-2b3d-4e8f-9a01-23456789abcd');
    expect(run('cobro_mesa12_AbC-09')).toBe('cobro_mesa12_AbC-09');
  });

  it('sin cabecera o vacía → 400', () => {
    expect(() => idem(undefined, ctx({ headers: {} }))).toThrow(BadRequestException);
    expect(() => run('')).toThrow(/Missing/);
  });

  it('longitud: 8 y 200 valen; 7 y 201 no', () => {
    expect(run('a'.repeat(8))).toBe('a'.repeat(8));
    expect(run('Z'.repeat(200))).toBe('Z'.repeat(200));
    expect(() => run('a'.repeat(7))).toThrow(BadRequestException);
    expect(() => run('a'.repeat(201))).toThrow(/Invalid/);
  });

  it.each([
    ['espacios', 'clave con espacios'],
    ['puntos y dos puntos', 'pago.2026:10:16'],
    ['salto de línea final', 'abcdefgh12\n'],
    ['inyección de cabecera', 'abcdefgh\r\nX-Evil: 1'],
    ['no ASCII', 'cañaveral-2026'],
    ['comillas / SQL', "abcdefgh' OR '1'='1"],
    ['barra', 'abcd/efgh/ijkl'],
  ])('caracteres fuera de [A-Za-z0-9_-] (%s) → 400', (_caso, value) => {
    expect(() => run(value)).toThrow(BadRequestException);
  });

  it('cabecera repetida: cuenta la primera (y si la primera no vale, 400)', () => {
    expect(run(['primera-clave-1', 'segunda-clave-2'])).toBe('primera-clave-1');
    expect(() => run(['', 'segunda-clave-2'])).toThrow(BadRequestException);
    expect(() => run(['mala clave', 'segunda-clave-2'])).toThrow(BadRequestException);
  });
});

describe('@Tenant — el local sale SIEMPRE de la sesión verificada', () => {
  const tenant = factoryOf(Tenant);

  it('devuelve el tenantId del usuario autenticado', () => {
    expect(tenant(undefined, ctx({ user: USER, headers: {} }))).toBe(TENANT);
  });

  it('ignora cabeceras, query y body que traigan otro local', () => {
    const req = {
      user: USER,
      headers: { 'x-tenant-id': OTRO_TENANT, 'x-venue-slug': 'otro' },
      query: { tenantId: OTRO_TENANT },
      body: { tenantId: OTRO_TENANT },
      params: { tenantId: OTRO_TENANT },
    };
    expect(tenant(undefined, ctx(req))).toBe(TENANT);
  });

  it('sin usuario (AuthGuard no corrió) → error, nunca un local de la petición', () => {
    expect(() => tenant(undefined, ctx({ headers: { 'x-tenant-id': OTRO_TENANT }, body: { tenantId: OTRO_TENANT } }))).toThrow(
      /AuthGuard/,
    );
  });

  it('usuario con tenantId vacío → error', () => {
    expect(() => tenant(undefined, ctx({ user: { ...USER, tenantId: '' } }))).toThrow(/Tenant missing/);
  });
});

describe('@CurrentUser', () => {
  const current = factoryOf(CurrentUser);

  it('devuelve el usuario que dejó AuthGuard, o undefined en rutas públicas', () => {
    expect(current(undefined, ctx({ user: USER }))).toBe(USER);
    expect(current(undefined, ctx({ headers: { authorization: 'Bearer falso' } }))).toBeUndefined();
  });
});

describe('@Public / @Roles — metadatos que leen los guards', () => {
  it('@Public marca método y clase', () => {
    @Public()
    class Abierto {
      @Public()
      salud(): void {}
    }
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, Abierto)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, Abierto.prototype.salud)).toBe(true);
  });

  it('@Roles guarda la lista tal cual en el método', () => {
    class Panel {
      @Roles('OWNER', 'MANAGER')
      liquidar(): void {}
    }
    expect(Reflect.getMetadata(ROLES_KEY, Panel.prototype.liquidar)).toEqual(['OWNER', 'MANAGER']);
  });
});
