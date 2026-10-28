import { describe, it, expect } from 'vitest';
import { PAY_TEXT } from '../payments/pay-i18n';
import { CLIENT_ERROR_TEXT } from './client-errors';
import { WALLET_TEXT } from './wallet-text';
import { TOPUP_BLOCK_MESSAGES } from './wallet-topup-rules';
import { renderWalletPage } from './wallet-page';
import { renderQrChargePage } from './qr-charge-page';
import { genericObject, revokedObjectPatch } from './google-wallet/google-wallet-pass';
import type { ClientWalletState } from './wallet-charges.service';

/**
 * Lo que lee el cliente (/w, /s, /pay y su justificante, el pase de Google
 * Wallet) no habla del datáfono: se paga con el QR del personal o con el
 * código y el PIN en su móvil. El datáfono (PAX) puede no estar en el local.
 */
const POS_WORDS = /dat[aá]fono|\btpv\b|terminal/i;

/** Todos los textos de un diccionario (las funciones, con un valor de ejemplo). */
function strings(value: unknown, at = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[at, value]];
  if (typeof value === 'function') return [[at, String((value as (x: string) => unknown)('X'))]];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`));
  return [];
}

const state: ClientWalletState = {
  code: 'K7Q-4M2',
  balanceCents: 20_000,
  status: 'ACTIVE',
  closeRequested: false,
  hasFaceId: true,
  hasPin: true,
  hasCard: true,
  merged: false,
  refund: null,
  cards: ['4242'],
  movements: [],
};

describe('textos del cliente sin datáfono', () => {
  it('diccionarios de /w, /s, /pay y el justificante, y los avisos del API que ve en castellano', () => {
    const all = [
      ...strings(PAY_TEXT, 'PAY_TEXT'),
      ...strings(WALLET_TEXT, 'WALLET_TEXT'),
      ...strings(CLIENT_ERROR_TEXT, 'CLIENT_ERROR_TEXT'),
      ...strings(TOPUP_BLOCK_MESSAGES, 'TOPUP_BLOCK_MESSAGES'),
    ];
    expect(all.length).toBeGreaterThan(200);
    expect(all.filter(([, text]) => POS_WORDS.test(text))).toEqual([]);
  });

  it('las páginas tal cual salen: el saldo (pagar y recargar) y el cobro con QR', () => {
    const topUp = { allowed: true, block: null, presetsCents: [2000, 5000], minCents: 1000, maxCents: 30000 };
    const paid = { payToken: 'p', amountCents: 5000, authorizedAt: new Date().toISOString(), code: '7F2' };
    const now = new Date('2026-10-15T22:00:00Z');
    const view = {
      status: 'PENDING' as const,
      amountCents: 6000,
      serviceName: 'Masaje',
      venueName: 'Luna',
      requestedByName: 'Lola',
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      paidAt: null,
    };
    for (const lang of ['es', 'en', 'fr', 'pt'] as const) {
      const pages = [
        renderWalletPage('tok', lang, state, { topUp, paid, googleWallet: true }),
        renderQrChargePage('tok', lang, view, now),
        renderQrChargePage('tok', lang, { ...view, status: 'EXPIRED' }, now),
      ];
      for (const html of pages) expect(html.match(POS_WORDS)).toBeNull();
    }
  });

  it('el pase de Google Wallet', () => {
    const pass = genericObject({
      objectId: 'o',
      classId: 'c',
      brand: 'OxioPay',
      walletUrl: 'https://api.x/w/t',
      chargeUrl: 'https://api.x/c/t',
      wallet: { balanceCents: 1000, status: 'EXPIRED', merged: false, venueName: 'Luna' },
    });
    const texts = [...strings(pass.textModulesData), ...strings(pass.linksModuleData), ...strings(revokedObjectPatch())];
    expect(texts.length).toBeGreaterThan(5);
    expect(texts.filter(([, text]) => POS_WORDS.test(text))).toEqual([]);
  });
});
