import { describe, expect, it } from 'vitest';
import { STAFF_CARD_NOT_BLANK_MESSAGE } from '@nightpay/contracts';
import { writeStaffCard, type NdefWriterCtor, type NdefWriterLike } from './staff-card-nfc';

/** Un lector de pega: al escanear «acerca» la ficha que se le diga y apunta lo que se graba. */
function fakeReader(tag: { serialNumber?: string; records: Array<{ recordType: string; data?: DataView }> }) {
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

const CODE = 'codigoDePrueba0123456';
const signal = () => new AbortController().signal;
const urlRecord = (url: string) => ({ recordType: 'url', data: new DataView(new TextEncoder().encode(url).buffer) });

describe('grabar la ficha de la compañera desde su hoja', () => {
  it('una ficha en blanco: le graba el enlace sin pisar nada y devuelve su código y su número de serie', async () => {
    const { Reader, written } = fakeReader({ serialNumber: '04:a1:b2:c3:d4:e5:f6', records: [] });
    const out = await writeStaffCard(Reader, 'https://app.ejemplo.es', signal(), CODE);
    expect(out).toEqual({ card: CODE, uid: '04A1B2C3D4E5F6', written: true });
    expect(written).toEqual([{ data: 'https://app.ejemplo.es/?ficha=codigoDePrueba0123456', overwrite: false }]);
  });

  it('una ficha con otra cosa grabada no se toca', async () => {
    for (const records of [[{ recordType: 'url' }], [urlRecord('https://otra.web/promo')], [{ recordType: 'text' }]]) {
      const { Reader, written } = fakeReader({ serialNumber: '04a1b2c3', records });
      await expect(writeStaffCard(Reader, 'https://app.ejemplo.es', signal(), CODE)).rejects.toThrow(STAFF_CARD_NOT_BLANK_MESSAGE);
      expect(written).toEqual([]);
    }
  });

  it('ya grabada con uno de nuestros enlaces (se perdió la respuesta al darla): no se toca y sale su código para reintentar', async () => {
    const { Reader, written } = fakeReader({ serialNumber: '04a1b2c3', records: [urlRecord('https://app.ejemplo.es/?ficha=yaGrabadoAntes01234567')] });
    expect(await writeStaffCard(Reader, 'https://app.ejemplo.es', signal(), CODE)).toEqual({ card: 'yaGrabadoAntes01234567', uid: '04A1B2C3', written: false });
    expect(written).toEqual([]);
  });

  it('sin número de serie no se graba (sin él, una copia valdría)', async () => {
    const { Reader, written } = fakeReader({ records: [] });
    await expect(writeStaffCard(Reader, 'https://app.ejemplo.es', signal(), CODE)).rejects.toThrow(/número de serie/);
    expect(written).toEqual([]);
  });
});
