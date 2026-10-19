import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PublicWalletController } from './public-wallet.controller';

function makeController(googleWalletEnabled = false) {
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
  const gwallet = { enabled: googleWalletEnabled };
  const topUps = {
    options: vi.fn().mockResolvedValue({ allowed: true, block: null, presetsCents: [2000, 5000, 10000], minCents: 1000, maxCents: 30000 }),
    paidProof: vi.fn().mockResolvedValue(null),
    challenge: vi.fn().mockResolvedValue({ challenge: 'topup-reto' }),
    start: vi.fn().mockResolvedValue({ payToken: 'pay-tok-1', payUrl: '/pay/pay-tok-1?lang=es', claim: 'c'.repeat(43) }),
  };
  const config = { get: vi.fn(() => 'secreto-de-cookies-de-las-pruebas-0123456789') };
  return {
    controller: new PublicWalletController(
      charges as never,
      passkeys as never,
      gwallet as never,
      topUps as never,
      config as never,
    ),
    charges,
    passkeys,
    topUps,
  };
}

function fakeReply() {
  const reply = {
    body: '',
    status: () => reply,
    header: () => reply,
    send(body: string) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

describe('/w/:token — la página sabe si Google Wallet está configurado', () => {
  const state = {
    code: 'K7Q-4M2',
    balanceCents: 1000,
    status: 'ACTIVE',
    closeRequested: false,
    hasFaceId: false,
    hasPin: false,
    merged: false,
    refund: null,
    cards: [],
    movements: [],
  };

  it('configurado → la página lleva el botón (el JS lo enseña en Android); sin configurar, no', async () => {
    for (const enabled of [true, false]) {
      const { controller, charges } = makeController(enabled);
      charges.clientState.mockResolvedValueOnce(state);
      const reply = fakeReply();
      await controller.page('tok', 'es', undefined, reply as never);
      expect(reply.body.includes('id="gwCard"')).toBe(enabled);
    }
  });
});

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

describe('/w/:token/topup — «Recargar» desde el móvil', () => {
  function cookieReply() {
    const headers: Record<string, string> = {};
    const reply = {
      header(k: string, v: string) {
        headers[k] = v;
        return reply;
      },
    };
    return { reply, headers };
  }

  it('crea la recarga y deja la cookie de vuelta en /pay (HttpOnly) para el cobro creado', async () => {
    const { controller, topUps } = makeController();
    const { reply, headers } = cookieReply();
    const out = await controller.topUp('tok', { amountCents: 5000, key: 'k'.repeat(22), lang: 'en' }, 'api.x', 'es', reply as never);
    expect(out).toEqual({ payUrl: '/pay/pay-tok-1?lang=es' });
    expect(topUps.start).toHaveBeenCalledWith(
      'tok',
      { amountCents: 5000, key: 'k'.repeat(22), response: undefined, lang: 'en' },
      'api.x',
    );
    expect(headers['Set-Cookie']).toMatch(/^npw_[A-Za-z0-9_-]{22}=c{43}; Path=\/pay; Max-Age=\d+; HttpOnly; /);
  });

  it('sin idioma en el cuerpo, el del móvil; el reto del Face ID es del servicio', async () => {
    const { controller, topUps } = makeController();
    await controller.topUp('tok', undefined, undefined, 'en-GB,en;q=0.9', cookieReply().reply as never);
    expect(topUps.start).toHaveBeenCalledWith('tok', expect.objectContaining({ lang: 'en', amountCents: undefined }), undefined);
    await expect(controller.topUpChallenge('tok', 'api.x')).resolves.toEqual({ challenge: 'topup-reto' });
    expect(topUps.challenge).toHaveBeenCalledWith('tok', 'api.x');
  });

  it('si falla, no deja cookie', async () => {
    const { controller, topUps } = makeController();
    topUps.start.mockRejectedValueOnce(new BadRequestException('importe'));
    const { reply, headers } = cookieReply();
    await expect(controller.topUp('tok', { amountCents: 1 }, 'h', 'es', reply as never)).rejects.toThrow(BadRequestException);
    expect(headers['Set-Cookie']).toBeUndefined();
  });

  it('la página lleva si se puede recargar y el «Pagado» de ?pagado= (solo de este saldo, lo decide el servicio)', async () => {
    const { controller, topUps, charges } = makeController();
    charges.clientState.mockResolvedValueOnce({
      code: 'K7Q-4M2',
      balanceCents: 17_000,
      status: 'ACTIVE',
      closeRequested: false,
      hasFaceId: true,
      hasPin: true,
      merged: false,
      refund: null,
      cards: [],
      movements: [],
    });
    topUps.paidProof.mockResolvedValueOnce({ payToken: 'pay-1', amountCents: 5000, authorizedAt: new Date().toISOString(), code: '7F2' });
    const reply = fakeReply();
    await controller.page('tok', 'es', undefined, reply as never, 'pay-1');
    expect(topUps.paidProof).toHaveBeenCalledWith('tok', 'pay-1');
    expect(topUps.options).toHaveBeenCalledWith('tok');
    expect(reply.body).toContain('id="proof"');
    expect(reply.body).toContain('id="topupSheet"');
  });
});
