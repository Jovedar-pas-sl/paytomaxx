import { describe, expect, it, vi } from 'vitest';
import { PublicWalletController } from '../wallets/public-wallet.controller';
import type { ClientWalletState } from '../wallets/wallet-charges.service';
import { renderWalletPage } from '../wallets/wallet-page';
import { HOME_TOPUP_TEXT } from './home-topup-text';

/** La página del saldo con lo de «Cargar saldo antes de llegar»: la bienvenida, el QR de la ficha y la cookie. */

const state: ClientWalletState = {
  code: 'K7Q-4M2',
  balanceCents: 5000,
  status: 'ACTIVE',
  closeRequested: false,
  hasFaceId: false,
  hasPin: false,
  hasCard: false,
  fichaNumber: null,
  venueName: 'Sala Aurora',
  merged: false,
  refund: null,
  cards: [],
  movements: [],
};
const proof = { payToken: 'payTok', amountCents: 5000, authorizedAt: new Date().toISOString(), code: '7F2' };
const topUp = { allowed: true, block: null, presetsCents: [2000, 5000, 10000], minCents: 1000, maxCents: 30000, serviceFeeBps: null, feesCents: null };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" data-test="ficha"></svg>';

/** La configuración que lee el JS de la página (JSON.parse("…")). */
function config(html: string): Record<string, unknown> {
  const m = /JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(html);
  if (!m?.[1]) throw new Error('sin configuración');
  return JSON.parse(JSON.parse(m[1]) as string) as Record<string, unknown>;
}

describe('renderWalletPage con la bienvenida del saldo cargado desde casa', () => {
  it('el «Pagado» y la bienvenida arriba (no en «Recargar») y la página en «Pagar»', () => {
    const html = renderWalletPage('tok', 'es', state, { topUp, paid: proof, welcome: true, payer: '/pay/payTok', fichaQr: SVG });
    expect(html).toContain('id="welcome"');
    expect(html).toContain(HOME_TOPUP_TEXT.es.welcomeTitle.replace('{venue}', 'Sala Aurora'));
    expect(html.indexOf('id="proof"')).toBeLessThan(html.indexOf('id="seg"'));
    // Un solo «Pagado».
    expect(html.split('id="proof"').length).toBe(2);
    expect(config(html)).toMatchObject({ paid: false, welcome: true, payer: '/pay/payTok' });
    // Al quitar ?nuevo= de la barra: queda el enlace del saldo, limpio.
    expect(html).toContain("if(C.paid||C.welcome){try{history.replaceState(null,'',C.base+'?lang='+C.lang);}catch(e){}}");
  });

  it('sin bienvenida, el «Pagado» de «Recargar» como siempre (y sin el JS del comprobante)', () => {
    const html = renderWalletPage('tok', 'es', state, { topUp, paid: proof });
    expect(html).not.toContain('id="welcome"');
    expect(html).not.toContain('function rcpDraw(');
    expect(renderWalletPage('tok', 'es', state, { topUp, paid: proof, welcome: true, fichaQr: SVG })).toContain('function rcpDraw(');
    expect(html.indexOf('id="proof"')).toBeGreaterThan(html.indexOf('id="viewTop"'));
    expect(config(html)).toMatchObject({ paid: true, welcome: false });
  });

  it('el QR de la ficha en «Tu código», y el JS lo quita al darle la ficha', () => {
    const html = renderWalletPage('tok', 'fr', state, { topUp, fichaQr: SVG });
    const codeCard = html.slice(html.indexOf('id="codeCard"'), html.indexOf('</section>', html.indexOf('id="codeCard"')));
    expect(codeCard).toContain('data-test="ficha"');
    expect(codeCard).toContain(HOME_TOPUP_TEXT.fr.fichaQrHint);
    expect(html).toContain('lostRender(s);welcomeRender(s);');
    expect(renderWalletPage('tok', 'es', state, { topUp })).not.toContain('id="fichaQr"');
  });

  it('«Recargar mi saldo» desde el enlace del local abre «Recargar» (#recargar)', () => {
    expect(renderWalletPage('tok', 'es', state, { topUp })).toContain("if(location.hash==='#recargar'&&topCan(S))view='top';");
  });
});

describe('PublicWalletController.page con ?nuevo=', () => {
  function make(welcome: { fichaQr: () => Promise<string | null>; rememberCookie: () => string | null } | undefined) {
    const charges = {
      walletRefByToken: vi.fn().mockResolvedValue({ id: 'w-1', shortCode: 'K7Q4M2' }),
      clientState: vi.fn().mockResolvedValue(state),
    };
    const passkeys = { hasPasskey: vi.fn().mockResolvedValue(false) };
    const topUps = { options: vi.fn().mockResolvedValue(topUp), paidProof: vi.fn().mockResolvedValue(proof) };
    const config = { get: vi.fn(() => 'secreto-de-cookies-de-las-pruebas-0123456789') };
    const activation = { payerBase: vi.fn().mockResolvedValue('/pay/payTok') };
    const controller = new PublicWalletController(
      charges as never,
      passkeys as never,
      { enabled: true } as never,
      topUps as never,
      config as never,
      activation as never,
      welcome as never,
    );
    const headers: Array<[string, string]> = [];
    const reply = {
      body: '',
      status: () => reply,
      header(k: string, v: string) {
        headers.push([k, v]);
        return reply;
      },
      send(body: string) {
        reply.body = body;
        return reply;
      },
    };
    return { controller, reply, headers, topUps };
  }

  it('enseña el «Pagado» de ese cobro como bienvenida, el QR de la ficha y deja la cookie del enlace del local', async () => {
    const welcome = { fichaQr: vi.fn().mockResolvedValue(SVG), rememberCookie: vi.fn(() => 'np_saldos=w-1.sig; Path=/r') };
    const m = make(welcome);
    await m.controller.page('tok', 'es', m.reply as never, undefined, 'np_saldos=viejo', 'payTok');
    expect(m.topUps.paidProof).toHaveBeenCalledWith('tok', 'payTok');
    expect(welcome.rememberCookie).toHaveBeenCalledWith({ id: 'w-1', qrToken: 'tok' }, 'np_saldos=viejo');
    expect(m.headers).toContainEqual(['Set-Cookie', 'np_saldos=w-1.sig; Path=/r']);
    expect(m.reply.body).toContain('id="welcome"');
    expect(m.reply.body).toContain('data-test="ficha"');
  });

  it('sin el servicio (pruebas de antes): la página de siempre', async () => {
    const m = make(undefined);
    await m.controller.page('tok', 'es', m.reply as never);
    expect(m.reply.body).not.toContain('id="welcome"');
    expect(m.headers.some(([k, v]) => k === 'Set-Cookie' && v.startsWith('np_saldos='))).toBe(false);
  });
});
