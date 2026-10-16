import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PublicWalletController } from './public-wallet.controller';

function makeController() {
  const charges = {
    walletRefByToken: vi.fn().mockResolvedValue({ id: 'w-1', shortCode: 'K7Q4M2' }),
    setPinFromPayer: vi.fn().mockResolvedValue(undefined),
    clientState: vi.fn().mockResolvedValue({ code: 'K7Q-4M2', hasPin: true }),
    mergeInto: vi.fn().mockResolvedValue({ balanceCents: 35_000 }),
  };
  const passkeys = {
    challenge: vi.fn().mockResolvedValue({ challenge: 'abc' }),
    verify: vi.fn().mockResolvedValue('w-target'),
  };
  return { controller: new PublicWalletController(charges as never, passkeys as never), charges, passkeys };
}

describe('/w/:token — PIN y sumar a otro saldo (acciones secundarias de la página del saldo)', () => {
  it('PIN: 4 cifras y repetido igual; se guarda en el saldo de este enlace', async () => {
    const { controller, charges } = makeController();
    await expect(controller.pin('tok', { pin: '1234', pin2: '1234' })).resolves.toMatchObject({ hasPin: true });
    expect(charges.walletRefByToken).toHaveBeenCalledWith('tok');
    expect(charges.setPinFromPayer).toHaveBeenCalledWith('w-1', '1234');
  });

  it('PIN mal escrito o distinto → 400 sin tocar nada', async () => {
    const { controller, charges } = makeController();
    await expect(controller.pin('tok', { pin: '12a4', pin2: '12a4' })).rejects.toThrow(BadRequestException);
    await expect(controller.pin('tok', { pin: '1234', pin2: '1235' })).rejects.toThrow(BadRequestException);
    await expect(controller.pin('tok', { pin: 1234, pin2: 1234 })).rejects.toThrow(BadRequestException);
    await expect(controller.pin('tok', undefined)).rejects.toThrow(BadRequestException);
    expect(charges.setPinFromPayer).not.toHaveBeenCalled();
  });

  it('sumar: el reto es solo para este saldo y la llave dice a cuál se suma', async () => {
    const { controller, charges, passkeys } = makeController();
    await controller.mergeChallenge('tok', 'pay.example');
    expect(passkeys.challenge).toHaveBeenCalledWith('merge:w-1', 'pay.example');
    await expect(controller.merge('tok', { response: { id: 'k' } }, 'pay.example')).resolves.toEqual({
      balanceCents: 35_000,
    });
    expect(passkeys.verify).toHaveBeenCalledWith('merge:w-1', 'pay.example', { id: 'k' });
    expect(charges.mergeInto).toHaveBeenCalledWith('w-1', 'w-target');
  });

  it('llave que no vale → no se suma nada', async () => {
    const { controller, charges, passkeys } = makeController();
    passkeys.verify.mockRejectedValueOnce(new BadRequestException('Llave no válida'));
    await expect(controller.merge('tok', { response: {} }, 'pay.example')).rejects.toThrow('Llave no válida');
    expect(charges.mergeInto).not.toHaveBeenCalled();
  });
});
