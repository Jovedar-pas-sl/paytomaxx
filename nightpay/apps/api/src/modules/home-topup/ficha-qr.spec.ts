import { describe, expect, it } from 'vitest';
import { fichaQrContent, parseFichaQr } from '@nightpay/contracts';
import { fichaProof, fichaProofValid, fichaQrSvg } from './ficha-qr';

const SECRET = 'secreto-de-cookies-de-prueba-0123456789';
const W1 = { id: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', qrToken: 'enlace-1' };
const W2 = { id: '3b4c5d6e-7f8a-4b9c-8d1e-2f3a4b5c6d7e', qrToken: 'enlace-2' };

describe('la prueba del QR de la ficha', () => {
  it('es del saldo y de su enlace de ahora: la misma siempre; otra en otro saldo, con otro enlace o con otro secreto', () => {
    const p = fichaProof(SECRET, W1);
    expect(p).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fichaProof(SECRET, W1)).toBe(p);
    expect(fichaProof(SECRET, W2)).not.toBe(p);
    expect(fichaProof(SECRET, { ...W1, qrToken: 'enlace-nuevo' })).not.toBe(p);
    expect(fichaProof('otro-secreto-de-cookies-0123456789', W1)).not.toBe(p);
  });

  it('vale solo la de ese saldo (ni de otro, ni tras un enlace nuevo, ni cambiada, ni sin secreto)', () => {
    const p = fichaProof(SECRET, W1);
    expect(fichaProofValid(SECRET, W1, p)).toBe(true);
    expect(fichaProofValid(SECRET, W2, p)).toBe(false);
    expect(fichaProofValid(SECRET, { ...W1, qrToken: 'enlace-nuevo' }, p)).toBe(false);
    expect(fichaProofValid(SECRET, W1, `${p.slice(0, 21)}${p.endsWith('A') ? 'B' : 'A'}`)).toBe(false);
    expect(fichaProofValid('', W1, p)).toBe(false);
    for (const bad of [undefined, null, '', 'corta', `${p}x`, 12]) expect(fichaProofValid(SECRET, W1, bad)).toBe(false);
  });
});

describe('lo que lleva el QR y cómo lo lee recepción', () => {
  it('texto, no un enlace: NPF:código:prueba', () => {
    const p = fichaProof(SECRET, W1);
    expect(fichaQrContent('K7Q4M2', p)).toBe(`NPF:K7Q4M2:${p}`);
    expect(parseFichaQr(`  NPF:K7Q4M2:${p} `)).toEqual({ code: 'K7Q4M2', proof: p });
  });

  it('no son de ficha: el código suelto, los enlaces, una prueba corta u otra cosa', () => {
    const p = fichaProof(SECRET, W1);
    for (const bad of [
      'K7Q4M2',
      `https://operator.example.com/?saldo=K7Q4M2&p=${p}`,
      'https://api.example.com/w/abcdefghijklmnopqrstuvwx',
      `NPF:K7Q4:${p}`,
      `NPF:K7Q4M2:${p.slice(1)}`,
      `NPF:k7q4m2:${p}`,
      '',
      'x'.repeat(600),
    ]) {
      expect(parseFichaQr(bad)).toBeNull();
    }
  });

  it('el SVG del QR: tinta sobre crema y nada del enlace del saldo', async () => {
    const svg = await fichaQrSvg({ secret: SECRET, wallet: W1, code: 'K7Q4M2' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('#1f2c36');
    expect(svg).toContain('#efe9df');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('enlace-1');
  });
});
