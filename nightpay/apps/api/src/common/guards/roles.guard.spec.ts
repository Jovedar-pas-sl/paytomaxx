import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '@nightpay/contracts';
import { Roles, ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

const TENANT = '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01';
const USER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

/** Controlador de pega: la clase solo para el dueño, con excepciones por método. */
@Roles('OWNER')
class CierreNocheController {
  cerrar(): void {}

  @Roles('OWNER', 'MANAGER', 'WAITER')
  verCarta(): void {}

  @Roles()
  sinRoles(): void {}
}

@Roles('OWNER', 'MANAGER')
class PanelController {
  listar(): void {}

  @Roles('OWNER')
  liquidar(): void {}
}

class LibreController {
  salud(): void {}
}

function user(role: string): JwtPayload {
  return { sub: USER, email: 'enc@sala-luna.es', role: role as JwtPayload['role'], tenantId: TENANT, venueSlug: 'luna' };
}

function ctx(cls: { prototype: object }, method: string, who?: JwtPayload): ExecutionContext {
  const handler = (cls.prototype as Record<string, unknown>)[method];
  const req = { user: who, headers: {} };
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new RolesGuard(new Reflector());

describe('RolesGuard — sin @Roles', () => {
  it('ni en el método ni en la clase: deja pasar, incluso sin usuario', () => {
    expect(guard.canActivate(ctx(LibreController, 'salud'))).toBe(true);
    expect(guard.canActivate(ctx(LibreController, 'salud', user('WAITER')))).toBe(true);
  });
});

describe('RolesGuard — con @Roles', () => {
  it('rol del usuario en la lista de la clase → pasa', () => {
    expect(guard.canActivate(ctx(CierreNocheController, 'cerrar', user('OWNER')))).toBe(true);
    expect(guard.canActivate(ctx(PanelController, 'listar', user('MANAGER')))).toBe(true);
  });

  it.each(['MANAGER', 'WAITER', 'OPERATOR'])('rol %s fuera de la lista → 403', (role) => {
    expect(() => guard.canActivate(ctx(CierreNocheController, 'cerrar', user(role)))).toThrow(ForbiddenException);
  });

  it('sin usuario en la petición → 403 (nunca deja pasar)', () => {
    expect(() => guard.canActivate(ctx(CierreNocheController, 'cerrar'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx(PanelController, 'liquidar'))).toThrow(/Authentication/);
  });

  it('usuario sin rol → 403', () => {
    const sinRol = { ...user('OWNER'), role: undefined } as unknown as JwtPayload;
    expect(() => guard.canActivate(ctx(PanelController, 'listar', sinRol))).toThrow(ForbiddenException);
  });

  it('roles que no son del enum (SUPERADMIN, "owner" en minúsculas, "") no pasan', () => {
    for (const role of ['SUPERADMIN', 'owner', 'Owner', '']) {
      expect(() => guard.canActivate(ctx(PanelController, 'listar', user(role)))).toThrow(ForbiddenException);
    }
  });

  it('el tenant del usuario no cambia la decisión: solo cuenta el rol', () => {
    const otroLocal = { ...user('WAITER'), tenantId: '00000000-0000-4000-8000-000000000000' };
    expect(() => guard.canActivate(ctx(PanelController, 'listar', otroLocal))).toThrow(ForbiddenException);
  });
});

describe('RolesGuard — método frente a clase', () => {
  it('el @Roles del método manda sobre el de la clase (aquí, más amplio)', () => {
    expect(guard.canActivate(ctx(CierreNocheController, 'verCarta', user('WAITER')))).toBe(true);
    expect(() => guard.canActivate(ctx(CierreNocheController, 'verCarta', user('OPERATOR')))).toThrow(
      ForbiddenException,
    );
  });

  it('el @Roles del método también restringe más que el de la clase', () => {
    expect(guard.canActivate(ctx(PanelController, 'liquidar', user('OWNER')))).toBe(true);
    expect(() => guard.canActivate(ctx(PanelController, 'liquidar', user('MANAGER')))).toThrow(ForbiddenException);
  });

  it('@Roles() vacío en el método anula el de la clase y deja pasar a todos (comportamiento actual)', () => {
    // Ojo: lista vacía = sin restricción. Nadie usa @Roles() vacío hoy.
    expect(guard.canActivate(ctx(CierreNocheController, 'sinRoles', user('OPERATOR')))).toBe(true);
  });

  it('pregunta primero al método y luego a la clase', () => {
    const reflector = new Reflector();
    const spy = vi.spyOn(reflector, 'getAllAndOverride');
    new RolesGuard(reflector).canActivate(ctx(PanelController, 'liquidar', user('OWNER')));
    expect(spy).toHaveBeenCalledWith(ROLES_KEY, [PanelController.prototype.liquidar, PanelController]);
  });
});
