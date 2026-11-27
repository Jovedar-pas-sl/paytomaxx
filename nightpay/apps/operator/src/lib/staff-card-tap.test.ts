import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICIO_SCAN_TEXTS, staffCardTap } from './servicio';

// Cobro por el encargado, fase 2: en «Escanea el Mi QR de la compañera» también vale su ficha NFC.
describe('la ficha de la compañera al cobrar a su nombre', () => {
  it('una ficha con su código y su número de serie se pregunta al servidor', () => {
    expect(staffCardTap({ token: 'abcdefghijklmnop0123', uid: '04A1B2C3D4E5F6' }, undefined)).toEqual({
      card: 'abcdefghijklmnop0123',
      uid: '04A1B2C3D4E5F6',
      raw: 'ficha:abcdefghijklmnop0123',
    });
  });

  it('sin número de serie no se sabe si es la original: no se manda', () => {
    expect(staffCardTap({ token: 'abcdefghijklmnop0123', uid: null }, undefined)).toEqual({ problem: expect.stringMatching(/número de serie/) });
  });

  it('una ficha vacía o de otra cosa no es la de una compañera', () => {
    expect(staffCardTap({ token: null, uid: '04A1B2C3' }, undefined)).toEqual({ problem: expect.stringMatching(/no es la de una compañera/) });
  });

  it('«Otra compañera»: la misma ficha de antes no se vuelve a reconocer', () => {
    expect(staffCardTap({ token: 'abcdefghijklmnop0123', uid: '04A1B2C3' }, 'ficha:abcdefghijklmnop0123')).toEqual({
      problem: expect.stringMatching(/misma compañera/),
    });
  });

  it('el escáner del servicio dice que vale su ficha (solo donde el móvil lee fichas)', () => {
    expect(SERVICIO_SCAN_TEXTS.nfcHint).toMatch(/ficha/);
    const scan = readFileSync(join(__dirname, '../components/cobrar/EscanearChica.tsx'), 'utf8');
    expect(scan).toMatch(/const nfcOn = Boolean\(texts\.nfcHint\) && nfcSupported\(\);/);
    expect(scan).toMatch(/resolveStaffCard\(tap\.card, tap\.uid\)/);
  });
});
