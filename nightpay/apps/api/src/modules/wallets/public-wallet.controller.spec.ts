import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PublicWalletController } from './public-wallet.controller';
import { walletViewSetCookies } from './wallet-view-session';
import { WalletPasskeysService } from './wallet-passkeys.service';

function makeController(googleWalletEnabled = false) {
  const charges = {
    walletRefByToken: vi.fn().mockResolvedValue({ id: 'w-1', shortCode: 'K7Q4M2' }),
    setPinFromPayer: vi.fn().mockResolvedValue(undefined),
    clientState: vi.fn().mockResolvedValue({ code: 'K7Q-4M2', hasPin: true }),
    mergeInto: vi.fn().mockResolvedValue({ balanceCents: 35_000 }),
    requestClose: vi.fn().mockResolvedValue({ code: 'K7Q-4M2', closeRequested: true }),
  };
  const passkeys = {
    hasPasskey: vi.fn().mockResolvedValue(false),
    challenge: vi.fn().mockResolvedValue({ challenge: 'abc' }),
    verify: vi.fn().mockResolvedValue('w-target'),
    // La de verdad (hasPasskey + verify de arriba).
    assertOwner: WalletPasskeysService.prototype.assertOwner,
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
    await expect(controller.pin('tok', { pin: '1234', pin2: '1234' }, 'pay.example')).resolves.toMatchObject({ hasPin: true });
    expect(charges.walletRefByToken).toHaveBeenCalledWith('tok');
    expect(charges.setPinFromPayer).toHaveBeenCalledWith('w-1', '1234');
  });

  it('PIN mal escrito o distinto → 400 sin tocar nada', async () => {
    const { controller, charges } = makeController();
    await expect(controller.pin('tok', { pin: '12a4', pin2: '12a4' }, 'h')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PIN_FORMAT' }),
    });
    await expect(controller.pin('tok', { pin: '1234', pin2: '1235' }, 'h')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PIN_MISMATCH' }),
    });
    await expect(controller.pin('tok', { pin: 1234, pin2: 1234 }, 'h')).rejects.toThrow(BadRequestException);
    await expect(controller.pin('tok', undefined, 'h')).rejects.toThrow(BadRequestException);
    expect(charges.setPinFromPayer).not.toHaveBeenCalled();
  });

  it('saldo con Face ID: con solo el enlace no se le pone PIN; con su llave (reto pin:<saldo>), sí', async () => {
    const { controller, charges, passkeys } = makeController();
    passkeys.hasPasskey.mockResolvedValue(true);
    passkeys.verify.mockRejectedValueOnce(new ForbiddenException({ message: 'Confirma con Face ID', code: 'FACE_ID_REQUIRED' }));
    await expect(controller.pin('tok', { pin: '1234', pin2: '1234' }, 'pay.example')).rejects.toThrow(ForbiddenException);
    expect(passkeys.verify).toHaveBeenCalledWith('pin:w-1', 'pay.example', undefined);
    // La llave de otro saldo tampoco.
    passkeys.verify.mockResolvedValueOnce('otro-saldo');
    await expect(controller.pin('tok', { pin: '1234', pin2: '1234', response: { id: 'k' } }, 'pay.example')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FACE_ID_WRONG' }),
    });
    expect(charges.setPinFromPayer).not.toHaveBeenCalled();
    passkeys.verify.mockResolvedValueOnce('w-1');
    await controller.pin('tok', { pin: '1234', pin2: '1234', response: { id: 'k' } }, 'pay.example');
    expect(charges.setPinFromPayer).toHaveBeenCalledWith('w-1', '1234');
  });

  it('reto para el PIN o «Me voy»: atado a la acción y al saldo; sin Face ID no hace falta (409)', async () => {
    const { controller, passkeys } = makeController();
    await expect(controller.pinChallenge('tok', 'pay.example')).rejects.toThrow(ConflictException);
    passkeys.hasPasskey.mockResolvedValue(true);
    await controller.pinChallenge('tok', 'pay.example');
    expect(passkeys.challenge).toHaveBeenCalledWith('pin:w-1', 'pay.example');
    await controller.closeChallenge('tok', 'pay.example');
    expect(passkeys.challenge).toHaveBeenCalledWith('close:w-1', 'pay.example');
  });

  it('«Me voy»: sin Face ID basta el enlace; con Face ID, solo con su llave (reto close:<saldo>)', async () => {
    const plain = makeController();
    await expect(plain.controller.close('tok', undefined, 'pay.example')).resolves.toMatchObject({ closeRequested: true });
    expect(plain.passkeys.verify).not.toHaveBeenCalled();

    const { controller, charges, passkeys } = makeController();
    passkeys.hasPasskey.mockResolvedValue(true);
    passkeys.verify.mockRejectedValueOnce(new ForbiddenException('Confirma con Face ID'));
    await expect(controller.close('tok', {}, 'pay.example')).rejects.toThrow(ForbiddenException);
    expect(charges.requestClose).not.toHaveBeenCalled();
    passkeys.verify.mockResolvedValueOnce('w-1');
    await controller.close('tok', { response: { id: 'k' } }, 'pay.example');
    expect(passkeys.verify).toHaveBeenLastCalledWith('close:w-1', 'pay.example', { id: 'k' });
    expect(charges.requestClose).toHaveBeenCalledWith('tok');
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

  function cookieReply() {
    const headers: Record<string, string | string[]> = {};
    const reply = {
      header(k: string, v: string | string[]) {
        headers[k] = v;
        return reply;
      },
    };
    return { reply, headers };
  }

describe('/w/:token/topup — «Recargar» desde el móvil', () => {


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
      hasCard: false,
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
    expect(reply.body).toContain('id="topupForm"');
  });
});


describe('saldo con passkey: consultar también exige el desbloqueo', () => {
  it('el enlace y /state no muestran datos sin una sesión de consulta', async () => {
    const { controller, charges, passkeys } = makeController();
    passkeys.hasPasskey.mockResolvedValue(true);
    const reply = fakeReply();
    await controller.page('private-token', 'es', undefined, reply as never);
    expect(reply.body).toContain('Consulta tu saldo');
    expect(reply.body).not.toContain('K7Q-4M2');
    expect(charges.clientState).not.toHaveBeenCalled();
    await expect(controller.state('private-token', cookieReply().reply as never)).rejects.toMatchObject({ status: 401 });
    expect(charges.clientState).not.toHaveBeenCalled();
  });
  it('desbloquea solo la llave de este saldo y emite una cookie de consulta', async () => {
    const { controller, passkeys, charges } = makeController();
    passkeys.hasPasskey.mockResolvedValue(true);
    passkeys.verify.mockResolvedValue('w-1');
    const { reply, headers } = cookieReply();
    await expect(controller.viewUnlock('private-token', 'api.example', { response: { id: 'key' } }, reply as never)).resolves.toEqual({ url: '/w/private-token' });
    expect(passkeys.verify).toHaveBeenCalledWith('view:w-1', 'api.example', { id: 'key' });
    const set = headers['Set-Cookie'] as string[];
    expect(set.map((c) => c.split('; ')[1])).toEqual(['Path=/w/private-token', 'Path=/v1/wallets/public/private-token']);
    const cookie = set[0]!.split(';')[0];
    const polled = cookieReply();
    await expect(controller.state('private-token', polled.reply as never, cookie)).resolves.toMatchObject({ code: 'K7Q-4M2' });
    // Recién desbloqueada: no hace falta reescribirla en cada consulta.
    expect(polled.headers['Set-Cookie']).toBeUndefined();
    expect(charges.clientState).toHaveBeenCalledTimes(1);
    passkeys.verify.mockResolvedValue('w-other');
    const wrong = cookieReply();
    await expect(controller.viewUnlock('private-token', 'api.example', { response: {} }, wrong.reply as never)).rejects.toMatchObject({ status: 403 });
    expect(wrong.headers['Set-Cookie']).toBeUndefined();
  });
  it('no acepta una cookie de otro saldo y un reto no muestra datos', async () => {
    const { controller, charges, passkeys } = makeController();
    passkeys.hasPasskey.mockResolvedValue(true);
    const cookie = walletViewSetCookies('secreto-de-cookies-de-las-pruebas-0123456789', { id: 'otro', qrToken: 'token' })[0]!.split(';')[0];
    await expect(controller.state('private-token', cookieReply().reply as never, cookie)).rejects.toMatchObject({ status: 401 });
    await expect(controller.viewChallenge('private-token', 'api.example')).resolves.toEqual({ challenge: 'abc' });
    expect(passkeys.challenge).toHaveBeenCalledWith('view:w-1', 'api.example');
    expect(charges.clientState).not.toHaveBeenCalled();
  });
  it('la primera activación desde el enlace privado deja la consulta autorizada', async () => {
    const { controller, passkeys } = makeController();
    Object.assign(passkeys, { register: vi.fn().mockResolvedValue(undefined) });
    const { reply, headers } = cookieReply();
    await controller.passkeyRegister('private-token', { response: {} }, 'api.example', reply as never);
    const set = headers['Set-Cookie'] as string[];
    expect(set).toHaveLength(2);
    for (const c of set) expect(c).toContain('HttpOnly; SameSite=Strict');
    expect(set[0]).toContain('Path=/w/private-token;');
  });
});
