import { describe, expect, it, vi } from 'vitest';
import { fichaQrContent, parseFichaQr } from '@nightpay/contracts';
import { fichaProof, fichaProofValid } from './ficha-qr';
import { rememberValid, rememberedEntries } from './home-topup-rules';
import { WalletWelcomeService } from './wallet-welcome.service';
import { fichaQrBlock, RECEIPT_JS, welcomeCard, WELCOME_JS } from './wallet-welcome-view';

const SECRET = 'secreto-de-cookies-de-prueba-0123456789';
const W1 = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const active = { hasCard: false, status: 'ACTIVE', merged: false };

function make(row: Record<string, unknown> | null, env: Record<string, string> = {}) {
  const tx = { clientWallet: { findUnique: vi.fn(async () => row) } };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const config = { get: vi.fn((k: string) => ({ COOKIE_SECRET: SECRET, ...env })[k]) };
  return { service: new WalletWelcomeService(prisma as never, config as never), tx };
}

const wallet = { id: W1, shortCode: 'K7Q4M2', blockedAt: null, closeRequestedAt: null, pendingAssignAt: null, venue: { paymentMethods: null } };

describe('WalletWelcomeService: el QR de la ficha en la página del saldo', () => {
  it('saldo activo sin ficha en un local con fichas: el QR', async () => {
    const svg = await make(wallet).service.fichaQr('qrTok', active);
    expect(svg?.startsWith('<svg')).toBe(true);
  });

  it('lo que lleva lo lee recepción: el código y una prueba que vale para ese saldo con su enlace de ahora', () => {
    const parsed = parseFichaQr(fichaQrContent('K7Q4M2', fichaProof(SECRET, { id: W1, qrToken: 'qrTok' })));
    expect(parsed?.code).toBe('K7Q4M2');
    expect(fichaProofValid(SECRET, { id: W1, qrToken: 'qrTok' }, parsed?.proof)).toBe(true);
    expect(fichaProofValid(SECRET, { id: W1, qrToken: 'otro' }, parsed?.proof)).toBe(false);
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

  it('la cookie para el enlace del local: recuerda este saldo firmado con su enlace de ahora', () => {
    const set = make(wallet).service.rememberCookie({ id: W1, qrToken: 'qrTok' }, undefined);
    const [entry] = rememberedEntries(set?.split(';')[0]);
    expect(entry?.walletId).toBe(W1);
    expect(rememberValid(SECRET, entry!, 'qrTok')).toBe(true);
    expect(rememberValid(SECRET, entry!, 'enlace-nuevo')).toBe(false);
    expect(make(wallet, { COOKIE_SECRET: '' }).service.rememberCookie({ id: W1, qrToken: 'qrTok' }, undefined)).toBeNull();
  });
});

const PROOF = { payToken: 'payTok', amountCents: 5000, authorizedAt: '2026-10-30T20:14:00.000Z', code: '7F2' };

/** Lo que va en el atributo data-r (JSON escapado para HTML), ya leído. */
function receiptOf(html: string): Record<string, string> {
  const raw = /data-r="([^"]*)"/.exec(html)?.[1] ?? '';
  const json = raw.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return JSON.parse(json.replace(/\u00a0/g, ' ')) as Record<string, string>;
}

const rcp = new Function(`${RECEIPT_JS}; return { rcpWrap, rcpHeight, rcpKind };`)() as {
  rcpWrap: (x: { measureText: (t: string) => { width: number } }, text: string, maxW: number) => string[];
  rcpHeight: (qr: boolean, showLines: number, noteLines: number) => number;
  rcpKind: (ua: string, ipadOs: boolean) => 'inapp' | 'ios' | 'download';
};

describe('lo que pinta en la página del saldo', () => {
  it('la bienvenida con el local (y sin él, la frase sin nombre); el texto va escapado', () => {
    expect(welcomeCard('es', 'Sala <b>Aurora</b>', PROOF, 'K7Q-4M2')).toContain('Ya puedes usarlo en Sala &lt;b&gt;Aurora&lt;/b&gt;');
    expect(welcomeCard('en', null, PROOF, 'K7Q-4M2')).toContain('You can now use it at the venue');
    expect(welcomeCard('fr', 'Luna', PROOF, 'K7Q-4M2')).toContain('id="welShare"');
  });

  it('«Guardar comprobante» va primero y lleva lo que dibuja la imagen (nada que no se vea ya en la pantalla)', () => {
    const html = welcomeCard('es', 'Sala "Aurora" <b>', PROOF, 'K7Q-4M2');
    expect(html.indexOf('id="welReceipt"')).toBeLessThan(html.indexOf('id="welShare"'));
    // El JSON va escapado dentro del atributo: ni comillas ni etiquetas sueltas.
    expect(/data-r="([^"]*)"/.exec(html)?.[1]).not.toMatch(/[<>"]/);
    expect(receiptOf(html)).toEqual({
      venue: 'Sala "Aurora" <b>',
      kick: 'Saldo cargado',
      amount: '50,00 €',
      when: '30 oct 2026, 21:14',
      confirm: 'Código de confirmación 7F2',
      saldoLabel: 'Tu saldo',
      saldo: 'K7Q-4M2',
      show: 'Enséñalo en recepción y te dan tu ficha.',
      showNoQr: 'Al llegar, paga con tu móvil o dile este código en recepción.',
      private: 'Es personal: no lo compartas.',
      noExpiry: 'Tu saldo no caduca: lo gastas cuando vengas, hoy u otro día.',
      file: 'comprobante-K7Q-4M2.png',
      fail: 'No se ha podido crear la imagen. Haz una captura de pantalla.',
    });
    // La imagen en grande (para mantenerla pulsada dentro de Instagram), escondida hasta que haga falta.
    expect(html).toContain('<div class="rcpv" id="rcpView" role="dialog" aria-modal="true" aria-labelledby="rcpHold" hidden>');
    expect(receiptOf(welcomeCard('pt', 'Luna', PROOF, 'K7Q-4M2')).file).toBe('comprovativo-K7Q-4M2.png');
  });

  it('el comprobante: corta las frases largas por palabras y crece con ellas (con el QR o sin él)', () => {
    const x = { measureText: (t: string) => ({ width: t.length * 10 }) };
    expect(rcp.rcpWrap(x, 'uno dos tres cuatro', 90)).toEqual(['uno dos', 'tres', 'cuatro']);
    expect(rcp.rcpWrap(x, 'palabralarguisima', 50)).toEqual(['palabralarguisima']);
    expect(rcp.rcpHeight(true, 1, 2)).toBe(1806);
    expect(rcp.rcpHeight(false, 2, 1)).toBe(1118);
    // El QR se traza con su dibujo (Path2D), sin imágenes que no dejen sacar el PNG.
    expect(RECEIPT_JS).toContain('x.stroke(new Path2D(qr.d))');
    expect(RECEIPT_JS).not.toContain('new Image');
  });

  it('a dónde va la imagen: dentro de las apps (y los WebView de Android) no se descarga; el iPhone comparte; el resto descarga', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    expect(rcp.rcpKind(android, false)).toBe('download');
    expect(rcp.rcpKind(iphone, false)).toBe('ios');
    expect(rcp.rcpKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', true)).toBe('ios');
    expect(rcp.rcpKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0 Safari/537.36', false)).toBe('download');
    for (const app of [`${iphone} Instagram 350.0`, `${android} [FB_IAB/FB4A;FBAV/450.0]`, `${iphone} LinkedInApp`, `${android} musical_ly_2024`, `${android} Line/14.0`]) {
      expect(rcp.rcpKind(app, false)).toBe('inapp');
    }
    expect(rcp.rcpKind('Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 Version/4.0 Chrome/146.0 Mobile Safari/537.36', false)).toBe('inapp');
  });

  it('el bloque del QR y su JS (sin barras invertidas)', () => {
    expect(fichaQrBlock('pt', '<svg></svg>')).toContain('A sua tag NFC na receção');
    expect(WELCOME_JS).not.toContain('\\');
    expect(RECEIPT_JS).not.toContain('\\');
    expect(WELCOME_JS).toContain('function welcomeRender(s)');
  });
});
