import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { GoogleWalletController } from './google-wallet.controller';
import { GOOGLE_WALLET_BUTTONS } from './google-wallet-button';

function meta(method: keyof GoogleWalletController, key: string): unknown {
  return Reflect.getMetadata(key, GoogleWalletController.prototype[method] as object);
}

function fakeReply() {
  const reply = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '' as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    header(name: string, value: string) {
      reply.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

describe('POST /w/:token/google-wallet', () => {
  it('pública como el resto de /w, sin caché y con límite por IP', () => {
    expect(Reflect.getMetadata(PATH_METADATA, GoogleWalletController)).toBe('w');
    expect(meta('save', PATH_METADATA)).toBe(':token/google-wallet');
    expect(meta('save', METHOD_METADATA)).toBe(RequestMethod.POST);
    expect(meta('save', IS_PUBLIC_KEY)).toBe(true);
    expect(meta('save', 'np:ip-rate-limit')).toEqual({ max: 20, windowSec: 60, scope: 'wallet-gwallet' });
  });

  it('da el enlace del pase de ESTE saldo', async () => {
    const gwallet = { enabled: true, saveLink: vi.fn().mockResolvedValue({ saveUrl: 'https://pay.google.com/gp/v/save/x' }) };
    const controller = new GoogleWalletController(gwallet as never);
    await expect(controller.save('tok')).resolves.toEqual({ saveUrl: 'https://pay.google.com/gp/v/save/x' });
    expect(gwallet.saveLink).toHaveBeenCalledWith('tok');
  });
});

describe('GET /w/assets/google-wallet/:lang — el botón oficial desde nuestro dominio', () => {
  it('es el SVG oficial de Google, sin tocar (sha256 del fichero del zip)', () => {
    for (const button of Object.values(GOOGLE_WALLET_BUTTONS)) {
      expect(createHash('sha256').update(button.svg, 'utf8').digest('hex')).toBe(button.sha256);
      expect(button.svg.startsWith(`<svg width="${button.width}" height="${button.height}"`)).toBe(true);
      expect(button.svg).not.toMatch(/<script|on[a-z]+=|href=/i);
    }
    expect(GOOGLE_WALLET_BUTTONS.es.file).toBe('esES_add_to_google_wallet_wallet-button.svg');
    expect(GOOGLE_WALLET_BUTTONS.es.alt).toBe('Añadir a Google Wallet');
    // Francés y portugués: los oficiales del mismo zip (el de portugués es el único que da Google).
    expect(GOOGLE_WALLET_BUTTONS.fr.file).toBe('frFR_add_to_google_wallet_wallet-button.svg');
    expect(GOOGLE_WALLET_BUTTONS.fr.alt).toBe('Ajouter au Google Wallet');
    expect(GOOGLE_WALLET_BUTTONS.pt.file).toBe('pt_add_to_google_wallet_wallet-button.svg');
  });

  it('se sirve como imagen SVG, con caché y sin poder ejecutar nada', () => {
    const controller = new GoogleWalletController({ enabled: true } as never);
    const reply = fakeReply();
    controller.button('es', reply as never);
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['Content-Type']).toBe('image/svg+xml; charset=utf-8');
    expect(reply.headers['Cache-Control']).toMatch(/^public, max-age=\d+$/);
    expect(reply.headers['Content-Security-Policy']).toBe("default-src 'none'");
    expect(reply.body).toBe(GOOGLE_WALLET_BUTTONS.es.svg);
  });

  it('los cuatro idiomas del cliente; otro idioma o Google Wallet sin configurar → 404', () => {
    for (const lang of ['es', 'en', 'fr', 'pt']) {
      const reply = fakeReply();
      new GoogleWalletController({ enabled: true } as never).button(lang, reply as never);
      expect(reply.statusCode).toBe(200);
    }
    expect(() => new GoogleWalletController({ enabled: true } as never).button('de', fakeReply() as never)).toThrow(
      NotFoundException,
    );
    expect(() => new GoogleWalletController({ enabled: false } as never).button('es', fakeReply() as never)).toThrow(
      NotFoundException,
    );
  });
});
