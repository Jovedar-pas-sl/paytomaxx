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
    balanceCents: 0,
    issuedAt: new Date(),
  });
  return { service, passkeys };
}

describe('el QR de recepción de un saldo que ya tiene PIN', () => {
  function withPin(via: 'reception' | 'relink') {
    const passkeys = { registrationOptions: vi.fn().mockResolvedValue({ challenge: 'c' }), register: vi.fn().mockResolvedValue(undefined) };
    const charges = { checkClientPin: vi.fn().mockResolvedValue(undefined) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const prisma = { acrossVenues: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ payment: { findFirst: async () => null }, walletCashTopUp: { findFirst: async () => null } })) };
    const service = new WalletActivationUseService(prisma as never, passkeys as never, charges as never, audit as never);
    vi.spyOn(service as unknown as { usable: (token: string) => Promise<unknown> }, 'usable').mockResolvedValue({
      id: 'wallet-1', shortCode: 'K7Q4M2', tenantId: 'venue-1', qrToken: 'qr-1', hasPin: true, via, balanceCents: 5_000, issuedAt: new Date(),
    });
    return { service, passkeys, charges, audit };
  }

  it('pide el PIN antes de crear la llave en el móvil, y otra vez al registrarla', async () => {
    const { service, passkeys, charges } = withPin('reception');
    await expect(service.passkeyOptions('t', 'h')).rejects.toMatchObject({ response: { code: 'PIN_FORMAT' } });
    await expect(service.passkeyOptions('t', 'h', '12')).rejects.toMatchObject({ response: { code: 'PIN_FORMAT' } });
    expect(passkeys.registrationOptions).not.toHaveBeenCalled();
    await service.passkeyOptions('t', 'h', '4821');
    expect(charges.checkClientPin).toHaveBeenCalledWith('wallet-1', 'venue-1', '4821');
    expect(passkeys.registrationOptions).toHaveBeenCalled();
    await expect(service.registerPasskey('t', 'h', {})).rejects.toMatchObject({ response: { code: 'PIN_FORMAT' } });
    expect(passkeys.register).not.toHaveBeenCalled();
  });

  it('un PIN mal puesto no deja activar', async () => {
    const { service, passkeys, charges } = withPin('reception');
    charges.checkClientPin.mockRejectedValueOnce(new ConflictException({ code: 'PIN_WRONG' }));
    await expect(service.passkeyOptions('t', 'h', '0000')).rejects.toMatchObject({ response: { code: 'PIN_WRONG' } });
    expect(passkeys.registrationOptions).not.toHaveBeenCalled();
  });

  it('el enlace nuevo del dueño (con 2FA) no lo pide: es para quien lo perdió todo', async () => {
    const { service, passkeys, charges } = withPin('relink');
    await service.passkeyOptions('t', 'h');
    expect(charges.checkClientPin).not.toHaveBeenCalled();
    expect(passkeys.registrationOptions).toHaveBeenCalled();
  });

  it('activar por recepción un saldo que ya tenía dinero queda para Incidencias', async () => {
    const { service, audit } = withPin('reception');
    await service.registerPasskey('t', 'h', {}, '4821');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.activation_not_new', targetId: 'wallet-1', payload: { amountCents: 5_000, hadPin: true } }));
  });
});

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

describe('elegir el primer PIN con el QR de activación: el enlace cambia', () => {
  function withNewPin(o: { setPinError?: unknown; dropFails?: boolean } = {}) {
    const charges = {
      setFirstPinWithActivation: vi.fn(async () => {
        if (o.setPinError) throw o.setPinError;
      }),
    };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const prisma = { acrossVenues: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ payment: { findFirst: async () => null }, walletCashTopUp: { findFirst: async () => null } })) };
    // Los códigos del móvil (OXC1:) del saldo: el enlace cambia, se anulan tras guardar.
    const liveCodes = { dropWallet: vi.fn(async (_walletId: string) => (o.dropFails ? Promise.reject(new Error('redis caído')) : undefined)) };
    const service = new WalletActivationUseService(prisma as never, {} as never, charges as never, audit as never, liveCodes as never);
    vi.spyOn(service as unknown as { usable: (token: string) => Promise<unknown> }, 'usable').mockResolvedValue({
      id: 'wallet-1', shortCode: 'K7Q4M2', tenantId: 'venue-1', qrToken: 'qr-1', hasPin: false, via: 'reception', balanceCents: 0, issuedAt: new Date(),
    });
    return { service, charges, audit, liveCodes };
  }

  it('guardado el PIN, anula los códigos del móvil del saldo (una vez)', async () => {
    const { service, charges, liveCodes } = withNewPin();
    const out = await service.setPin('t', '4821');
    expect(out).toMatchObject({ walletId: 'wallet-1', qrToken: expect.any(String) });
    expect(out.qrToken).not.toBe('qr-1');
    expect(charges.setFirstPinWithActivation).toHaveBeenCalledOnce();
    expect(liveCodes.dropWallet).toHaveBeenCalledTimes(1);
    expect(liveCodes.dropWallet).toHaveBeenCalledWith('wallet-1');
  });

  it('si anular los códigos falla, el PIN queda elegido igual', async () => {
    const { service, audit, liveCodes } = withNewPin({ dropFails: true });
    await expect(service.setPin('t', '4821')).resolves.toMatchObject({ walletId: 'wallet-1' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.activation_used' }));
    expect(liveCodes.dropWallet).toHaveBeenCalledTimes(1);
  });

  it('si no se guarda (QR usado, PIN fácil…), no anula códigos', async () => {
    const { service, liveCodes } = withNewPin({ setPinError: new ConflictException({ code: 'ACTIVATION_USED' }) });
    await expect(service.setPin('t', '4821')).rejects.toMatchObject({ response: { code: 'ACTIVATION_USED' } });
    expect(liveCodes.dropWallet).not.toHaveBeenCalled();
  });
});
