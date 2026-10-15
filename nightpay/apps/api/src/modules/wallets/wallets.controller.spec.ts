import { describe, it, expect } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AdminWalletsController, WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

/** Roles de una ruta (lo que comprueba RolesGuard). */
function rolesOf(controller: { prototype: object }, method: string): string[] | undefined {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  return Reflect.getMetadata(ROLES_KEY, handler as object) as string[] | undefined;
}

/** Las rutas de un controlador: "POST :id/consume", "GET /"… */
function routesOf(controller: { prototype: object }): string[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    return path === undefined || method === undefined ? [] : [`${RequestMethod[method]} ${path}`];
  });
}

describe('rutas de saldos para el personal', () => {
  it('la lista de saldos (código, etiqueta y saldo de cada cliente) solo la ven el encargado y el dueño', () => {
    // Con el código y el PIN se paga: la chica o el camarero no pueden sacar la lista.
    expect(rolesOf(WalletsController, 'listActive')).toEqual(['MANAGER', 'OWNER']);
    expect(rolesOf(AdminWalletsController, 'list')).toEqual(['OWNER', 'MANAGER']);
  });

  it('cobrar del saldo sin el cliente ni una segunda persona ya no existe', () => {
    // Sin el cliente, el cobro con QR lo aprueba otro encargado (/v1/wallet-charges/:id/approve).
    expect(routesOf(WalletsController)).not.toContain('POST :id/consume');
    expect('consume' in WalletsService.prototype).toBe(false);
    expect(routesOf(WalletsController)).toEqual(
      expect.arrayContaining(['GET public/:qrToken', 'POST :id/consumptions/:consumptionId/reverse', 'GET :id']),
    );
  });
});
