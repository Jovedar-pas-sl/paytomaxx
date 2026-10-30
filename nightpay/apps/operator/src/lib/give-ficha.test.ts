import { describe, expect, it } from 'vitest';
import { readFichaQr, walletCodeOf } from './give-ficha';

const PROOF = 'abcdefghijklmnopqrstuv';

describe('dar ficha a un saldo: lo que lee recepción', () => {
  it('el QR del saldo (enlace a la app o en texto): su código y su prueba', () => {
    expect(readFichaQr(`https://operator.sala.test/?saldo=K7Q4M2&p=${PROOF}`)).toEqual({ code: 'K7Q4M2', proof: PROOF });
    expect(readFichaQr(`NPF:K7Q4M2:${PROOF}`)).toEqual({ code: 'K7Q4M2', proof: PROOF });
  });

  it('otros QR (el de un cobro, el código suelto, el del saldo sin prueba): no, con qué hacer', () => {
    for (const text of ['https://api.sala.test/s/abcdefghijklmnopqrstu', 'K7Q4M2', 'https://operator.sala.test/?saldo=K7Q4M2']) {
      expect(readFichaQr(text)).toMatchObject({ problem: expect.stringContaining('Tu ficha en recepción') });
    }
  });

  it('el código tecleado, con o sin guion y en minúsculas', () => {
    expect(walletCodeOf('k7q-4m2')).toBe('K7Q4M2');
    expect(walletCodeOf(' K7Q 4M2 ')).toBe('K7Q4M2');
    expect(walletCodeOf('K7Q4M')).toBeNull();
    expect(walletCodeOf('K7Q4M2X')).toBeNull();
  });
});
