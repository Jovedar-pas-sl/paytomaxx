import { describe, expect, it } from 'vitest';
import { STAFF_CARD_NOT_BLANK_MESSAGE } from '@nightpay/contracts';
import { newStaffCardToken, writeStaffCard, type NdefWriterCtor, type NdefWriterLike } from './staff-card-nfc';

/** Un lector de pega: al escanear «acerca» la ficha que se le diga y apunta lo que se graba. */
function fakeReader(tag: { serialNumber?: string; records: Array<{ recordType: string }> }) {
  const written: Array<{ data: string; overwrite: boolean | undefined }> = [];
  class Reader implements NdefWriterLike {
    onreading: NdefWriterLike['onreading'] = null;
    onreadingerror: NdefWriterLike['onreadingerror'] = null;
    async scan(): Promise<void> {
      setTimeout(() => this.onreading?.({ serialNumber: tag.serialNumber, message: { records: tag.records } }), 0);
    }
    async write(message: { records: Array<{ recordType: string; data: string }> }, options?: { overwrite?: boolean }): Promise<void> {
      written.push({ data: message.records[0]!.data, overwrite: options?.overwrite });
    }
  }
  return { Reader: Reader as NdefWriterCtor, written };
}

describe('grabar la ficha de la compañera desde su hoja', () => {
  it('una ficha en blanco: le graba el enlace sin pisar nada y devuelve su código y su número de serie', async () => {
    const { Reader, written } = fakeReader({ serialNumber: '04:a1:b2:c3:d4:e5:f6', records: [] });
    const out = await writeStaffCard(Reader, 'https://app.ejemplo.es', new AbortController().signal, () => 'codigoDePrueba0123456');
    expect(out).toEqual({ card: 'codigoDePrueba0123456', uid: '04A1B2C3D4E5F6' });
    expect(written).toEqual([{ data: 'https://app.ejemplo.es/?ficha=codigoDePrueba0123456', overwrite: false }]);
  });

  it('una ficha con algo grabado (la de un cliente) no se toca', async () => {
    const { Reader, written } = fakeReader({ serialNumber: '04a1b2c3', records: [{ recordType: 'url' }] });
    await expect(writeStaffCard(Reader, 'https://app.ejemplo.es', new AbortController().signal)).rejects.toThrow(STAFF_CARD_NOT_BLANK_MESSAGE);
    expect(written).toEqual([]);
  });

  it('sin número de serie no se graba (sin él, una copia valdría)', async () => {
    const { Reader, written } = fakeReader({ records: [] });
    await expect(writeStaffCard(Reader, 'https://app.ejemplo.es', new AbortController().signal)).rejects.toThrow(/número de serie/);
    expect(written).toEqual([]);
  });

  it('el código nuevo tiene el formato de las fichas (22 caracteres base64url)', () => {
    expect(newStaffCardToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newStaffCardToken()).not.toBe(newStaffCardToken());
  });
});
