import { describe, expect, it } from 'vitest';
import { fichaQrContent, parseFichaQr } from '@nightpay/contracts';
import { fichaProof, fichaProofValid, fichaQrSvg } from './ficha-qr';

const SECRET = 'secreto-de-cookies-de-prueba-0123456789';
const W1 = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const W2 = '3b4c5d6e-7f8a-4b9c-8d1e-2f3a4b5c6d7e';

describe('la prueba del QR de la ficha', () => {
  it('es del saldo: la misma siempre, otra en otro saldo o con otro secreto', () => {
    const p = fichaProof(SECRET, W1);
    expect(p).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fichaProof(SECRET, W1)).toBe(p);
    expect(fichaProof(SECRET, W2)).not.toBe(p);
    expect(fichaProof('otro-secreto-de-cookies-0123456789', W1)).not.toBe(p);
  });

  it('vale solo la de ese saldo (ni de otro, ni cambiada, ni sin secreto)', () => {
    const p = fichaProof(SECRET, W1);
    expect(fichaProofValid(SECRET, W1, p)).toBe(true);
    expect(fichaProofValid(SECRET, W2, p)).toBe(false);
    expect(fichaProofValid(SECRET, W1, `${p.slice(0, 21)}${p.endsWith('A') ? 'B' : 'A'}`)).toBe(false);
    expect(fichaProofValid('', W1, p)).toBe(false);
    for (const bad of [undefined, null, '', 'corta', `${p}x`, 12]) expect(fichaProofValid(SECRET, W1, bad)).toBe(false);
  });
});

describe('lo que lleva el QR y cómo lo lee recepción', () => {
  it('con la app del personal: su enlace con el código (los demás lectores lo leen como el código)', () => {
    const p = fichaProof(SECRET, W1);
    const content = fichaQrContent('K7Q4M2', p, 'https://operator.example.com/');
    expect(content).toBe(`https://operator.example.com/?saldo=K7Q4M2&p=${p}`);
    expect(parseFichaQr(content)).toEqual({ code: 'K7Q4M2', proof: p });
  });

  it('sin ella: NPF:código:prueba', () => {
    const p = fichaProof(SECRET, W1);
    expect(fichaQrContent('K7Q4M2', p, null)).toBe(`NPF:K7Q4M2:${p}`);
    expect(parseFichaQr(`  NPF:K7Q4M2:${p} `)).toEqual({ code: 'K7Q4M2', proof: p });
  });

  it('no son de ficha: el código suelto, el QR del saldo sin prueba, otra cosa o un enlace raro', () => {
    const p = fichaProof(SECRET, W1);
    for (const bad of [
      'K7Q4M2',
      'https://operator.example.com/?saldo=K7Q4M2',
      `https://operator.example.com/?saldo=K7Q4&p=${p}`,
      `https://operator.example.com/?saldo=K7Q4M2&p=${p.slice(1)}`,
      `javascript:alert(1)//?saldo=K7Q4M2&p=${p}`,
      'https://api.example.com/w/abcdefghijklmnopqrstuvwx',
      '',
      'x'.repeat(600),
    ]) {
      expect(parseFichaQr(bad)).toBeNull();
    }
  });

  it('el SVG del QR: tinta sobre crema y nada del enlace del saldo', async () => {
    const svg = await fichaQrSvg({ secret: SECRET, walletId: W1, code: 'K7Q4M2', operatorBase: 'https://operator.example.com' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('#1f2c36');
    expect(svg).toContain('#efe9df');
    expect(svg).not.toContain('<script');
  });
});
