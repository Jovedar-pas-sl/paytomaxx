import { describe, expect, it, vi } from 'vitest';
import { parseFichaQr } from '@nightpay/contracts';
import { fichaProofValid } from './ficha-qr';
import { rememberedWalletIds } from './home-topup-rules';
import { WalletWelcomeService } from './wallet-welcome.service';
import { fichaQrBlock, welcomeCard, WELCOME_JS } from './wallet-welcome-view';

const SECRET = 'secreto-de-cookies-de-prueba-0123456789';
const W1 = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const active = { hasCard: false, status: 'ACTIVE', merged: false };

function make(row: Record<string, unknown> | null, env: Record<string, string> = {}) {
  const tx = { clientWallet: { findUnique: vi.fn(async () => row) } };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const config = {
    get: vi.fn((k: string) => ({ COOKIE_SECRET: SECRET, NEXT_PUBLIC_API_URL: 'https://api.sala.test', NODE_ENV: 'test', ...env })[k]),
  };
  return { service: new WalletWelcomeService(prisma as never, config as never), tx };
}

const wallet = { id: W1, shortCode: 'K7Q4M2', blockedAt: null, closeRequestedAt: null, pendingAssignAt: null, venue: { paymentMethods: null } };

describe('WalletWelcomeService: el QR de la ficha en la página del saldo', () => {
  it('saldo activo sin ficha en un local con fichas: el QR con su código y la prueba de ese saldo', async () => {
    const svg = await make(wallet).service.fichaQr('qrTok', active);
    expect(svg?.startsWith('<svg')).toBe(true);
  });

  it('el contenido del QR lo lee recepción: el código y una prueba que vale para ese saldo', async () => {
    const { fichaQrContent } = await import('@nightpay/contracts');
    const { fichaProof } = await import('./ficha-qr');
    const parsed = parseFichaQr(fichaQrContent('K7Q4M2', fichaProof(SECRET, W1), 'https://operator.sala.test'));
    expect(parsed?.code).toBe('K7Q4M2');
    expect(fichaProofValid(SECRET, W1, parsed?.proof)).toBe(true);
  });

  it('no toca: ya con ficha, cerrado, sumado, bloqueado, con «Me voy», pendiente o sin fichas en el local', async () => {
    expect(await make(wallet).service.fichaQr('q', { ...active, hasCard: true })).toBeNull();
    expect(await make(wallet).service.fichaQr('q', { ...active, status: 'DEPLETED' })).toBeNull();
    expect(await make(wallet).service.fichaQr('q', { ...active, merged: true })).toBeNull();
    for (const extra of [{ blockedAt: new Date() }, { closeRequestedAt: new Date() }, { pendingAssignAt: new Date() }, { shortCode: null }]) {
      expect(await make({ ...wallet, ...extra }).service.fichaQr('q', active)).toBeNull();
    }
    expect(await make({ ...wallet, venue: { paymentMethods: { nfc: false } } }).service.fichaQr('q', active)).toBeNull();
    expect(await make(null).service.fichaQr('q', active)).toBeNull();
  });

  it('la cookie para el enlace del local: recuerda este saldo (firmado)', () => {
    const set = make(wallet).service.rememberCookie(W1, undefined);
    expect(rememberedWalletIds(set?.split(';')[0], SECRET)).toEqual([W1]);
    expect(make(wallet, { COOKIE_SECRET: '' }).service.rememberCookie(W1, undefined)).toBeNull();
  });
});

describe('lo que pinta en la página del saldo', () => {
  it('la bienvenida con el local (y sin él, la frase sin nombre); el texto va escapado', () => {
    expect(welcomeCard('es', 'Sala <b>Aurora</b>')).toContain('Ya puedes usarlo en Sala &lt;b&gt;Aurora&lt;/b&gt;');
    expect(welcomeCard('en', null)).toContain('You can now use it at the venue');
    expect(welcomeCard('fr', 'Luna')).toContain('id="welShare"');
  });

  it('el bloque del QR y su JS (sin barras invertidas)', () => {
    expect(fichaQrBlock('pt', '<svg></svg>')).toContain('A sua tag NFC na receção');
    expect(WELCOME_JS).not.toContain('\\');
    expect(WELCOME_JS).toContain('function welcomeRender(s)');
  });
});
