import { describe, it, expect } from 'vitest';
import { corsOrigin, parseCorsOrigins, socketOriginAllowed } from './cors';

const LIST = ['https://operator.paytomaxx.com', 'https://tpv.paytomaxx.com'];

describe('CORS', () => {
  it('CSV con espacios', () => {
    expect(parseCorsOrigins(' https://a.com , https://b.com,, ')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseCorsOrigins(undefined)).toEqual([]);
  });

  it('producción: solo la lista (sin lista, nada); local: cualquiera', () => {
    expect(corsOrigin(true, LIST)).toEqual(LIST);
    expect(corsOrigin(true, [])).toBe(false);
    expect(corsOrigin(false, [])).toBe(true);
  });

  it('Socket.io en producción: Origin de la lista o sin Origin; otro origen no', () => {
    expect(socketOriginAllowed('https://operator.paytomaxx.com', true, LIST)).toBe(true);
    expect(socketOriginAllowed(undefined, true, LIST)).toBe(true);
    expect(socketOriginAllowed('https://evil.example', true, LIST)).toBe(false);
    expect(socketOriginAllowed('https://evil.example', false, LIST)).toBe(true);
  });
});
