import { describe, it, expect } from 'vitest';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PublicWalletController } from './public-wallet.controller';
import { PayoutSchema, WalletChargesController } from './wallet-charges.controller';
import { WalletChargesService } from './wallet-charges.service';
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

  it('«Devolver saldo»: antes de confirmar, el encargado o el dueño ven lo que saldría; al confirmar mandan esa cifra', () => {
    expect(routesOf(WalletChargesController)).toEqual(
      expect.arrayContaining(['GET wallets/:id/payout-preview', 'POST wallets/:id/payout']),
    );
    expect(rolesOf(WalletChargesController, 'payoutPreview')).toEqual(['OWNER', 'MANAGER']);
    const body = new ZodValidationPipe(PayoutSchema);
    expect(body.transform({ method: 'CASH', expectedAmountCents: 3_000 })).toEqual({ method: 'CASH', expectedAmountCents: 3_000 });
    // Los paneles de antes no la mandan: sigue valiendo.
    expect(body.transform({ method: 'CARD' })).toEqual({ method: 'CARD' });
    expect(() => body.transform({ method: 'CASH', expectedAmountCents: 0 })).toThrow(BadRequestException);
    expect(() => body.transform({ method: 'CASH', expectedAmountCents: 12.5 })).toThrow(BadRequestException);
  });

  it('la devolución vieja del saldo (siempre fallaba y pisaba el saldo) ya no existe', () => {
    // El saldo se devuelve con /v1/wallet-charges/wallets/:id/payout (tarjeta o efectivo).
    expect(routesOf(WalletsController)).not.toContain('POST :id/refund');
    expect('refund' in WalletsService.prototype).toBe(false);
    // Las recargas las suma al saldo el cobro (payments), no este servicio.
    expect('creditFromTopUp' in WalletsService.prototype).toBe(false);
  });
});

describe('el cobro con petición que el cliente aceptaba en su página ya no existe', () => {
  it('ni pedirlo (POST /v1/wallet-charges) ni aceptarlo o rechazarlo en /w/:token', () => {
    expect(routesOf(WalletChargesController)).not.toContain('POST /');
    expect(routesOf(PublicWalletController)).not.toContain('POST :token/requests/:id/accept');
    expect(routesOf(PublicWalletController)).not.toContain('POST :token/requests/:id/reject');
    for (const gone of ['createRequest', 'accept', 'reject']) {
      expect(gone in WalletChargesService.prototype).toBe(false);
    }
  });

  it('el cobro con QR sigue: crearlo, seguirlo, retirarlo, pagarlo con PIN y que lo apruebe el encargado', () => {
    expect(routesOf(WalletChargesController)).toEqual(
      expect.arrayContaining(['POST qr', 'GET :id', 'POST :id/cancel', 'POST :id/pin', 'POST :id/approve']),
    );
    expect(routesOf(PublicWalletController)).toEqual(
      expect.arrayContaining(['GET :token', 'GET :token/state', 'POST :token/close', 'POST :token/passkey']),
    );
  });
});
