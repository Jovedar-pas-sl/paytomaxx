import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WalletActivationUseService } from './wallet-activation-use.service';

/**
 * Dos móviles con el mismo QR de activación a la vez: el segundo puede llegar
 * cuando el primero ya dejó su llave (WalletPasskeysService.register mira si
 * el saldo tiene Face ID antes de gastar el QR). Para el QR, eso es «gastado».
 */
function setup(registerError: unknown) {
  const passkeys = { register: vi.fn().mockRejectedValue(registerError) };
  const service = new WalletActivationUseService({} as never, passkeys as never, {} as never, {} as never);
  vi.spyOn(service as unknown as { usable: (token: string) => Promise<unknown> }, 'usable').mockResolvedValue({
    id: 'wallet-1',
    shortCode: 'K7Q4M2',
    tenantId: 'venue-1',
    qrToken: 'qr-1',
    hasPin: false,
    via: 'reception',
  });
  return { service, passkeys };
}

describe('activar Face ID con el QR de un solo uso, dos móviles a la vez', () => {
  it('el que llega tarde ve «Este enlace ya se ha usado», no «Tu saldo ya tiene Face ID»', async () => {
    const { service, passkeys } = setup(new ConflictException({ message: 'Tu saldo ya tiene Face ID activado', code: 'FACE_ID_EXISTS' }));
    await expect(service.registerPasskey('token-1', 'api.paytomaxx.com', {})).rejects.toMatchObject({
      status: 409,
      response: { code: 'ACTIVATION_USED', message: 'Este enlace ya se ha usado. Pide otro en recepción.' },
    });
    expect(passkeys.register).toHaveBeenCalledOnce();
  });

  it('los demás fallos del registro salen tal cual (p. ej. «Ha tardado demasiado»)', async () => {
    const timeout = new ConflictException({ message: 'Ha tardado demasiado: vuelve a intentarlo', code: 'FACE_ID_TIMEOUT' });
    const { service } = setup(timeout);
    await expect(service.registerPasskey('token-1', 'api.paytomaxx.com', {})).rejects.toBe(timeout);
  });
});
