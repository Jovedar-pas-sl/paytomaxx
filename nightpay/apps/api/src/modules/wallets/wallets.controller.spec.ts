import { describe, it, expect } from 'vitest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AdminWalletsController, WalletsController } from './wallets.controller';

/** Roles de una ruta (lo que comprueba RolesGuard). */
function rolesOf(controller: { prototype: object }, method: string): string[] | undefined {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  return Reflect.getMetadata(ROLES_KEY, handler as object) as string[] | undefined;
}

describe('rutas de saldos para el personal', () => {
  it('la lista de saldos (código, etiqueta y saldo de cada cliente) solo la ven el encargado y el dueño', () => {
    // Con el código y el PIN se paga: la chica o el camarero no pueden sacar la lista.
    expect(rolesOf(WalletsController, 'listActive')).toEqual(['MANAGER', 'OWNER']);
    expect(rolesOf(AdminWalletsController, 'list')).toEqual(['OWNER', 'MANAGER']);
  });
});
