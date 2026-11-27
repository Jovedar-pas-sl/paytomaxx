import { describe, expect, it } from 'vitest';
import { IdDocumentInputSchema, idDocumentProblem, maskIdDocumentNumber } from '@nightpay/contracts';
import { idDocumentData, idDocumentView, openIdDocument } from './id-document';

const KEK = 'kek-de-las-pruebas-del-documento-0123456789';
const NEREA = '0f8fad5b-d9cb-469f-a165-70867728950e';
const LOLA = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('el documento de la compañera, cifrado', () => {
  it('se guarda cifrado (tipo y número) y solo se abre con la clave y para su persona', () => {
    const data = idDocumentData(NEREA, { type: 'DNI', number: '12345678Z' }, KEK);
    expect(data.idDocumentType).toMatch(/^pa1:/);
    expect(data.idDocumentNumber).toMatch(/^pa1:/);
    expect(JSON.stringify(data)).not.toContain('12345678Z');
    expect(openIdDocument({ id: NEREA, ...data }, KEK)).toEqual({ type: 'DNI', number: '12345678Z' });
    // Copiado a otra persona, o con otra clave, no se abre.
    expect(() => openIdDocument({ id: LOLA, ...data }, KEK)).toThrow();
    expect(() => openIdDocument({ id: NEREA, ...data }, `${KEK}-otra`)).toThrow();
    // El número en el campo del tipo (o al revés), tampoco.
    expect(() => openIdDocument({ id: NEREA, idDocumentType: data.idDocumentNumber, idDocumentNumber: data.idDocumentType }, KEK)).toThrow();
  });

  it('el panel lo ve tapado: el tipo y los últimos caracteres', () => {
    const data = idDocumentData(NEREA, { type: 'NIE', number: 'X1234567L' }, KEK);
    expect(idDocumentView({ id: NEREA, ...data }, KEK)).toEqual({ idDocumentType: 'NIE', idDocumentMasked: '•••• 567L' });
    expect(maskIdDocumentNumber('AB12345')).toBe('•••• 345');
    // Sin documento, nada; si no se puede abrir, solo «••••».
    expect(idDocumentView({ id: NEREA }, KEK)).toEqual({ idDocumentType: null, idDocumentMasked: null });
    expect(idDocumentView({ id: LOLA, ...data }, KEK)).toEqual({ idDocumentType: null, idDocumentMasked: '••••' });
  });

  it('quitarlo (o la baja) deja las dos columnas vacías', () => {
    expect(idDocumentData(NEREA, null, KEK)).toEqual({ idDocumentType: null, idDocumentNumber: null });
  });

  it('el número se limpia y se comprueba (la letra del DNI y del NIE)', () => {
    expect(IdDocumentInputSchema.parse({ type: 'DNI', number: ' 12.345.678-z ' })).toEqual({ type: 'DNI', number: '12345678Z' });
    expect(IdDocumentInputSchema.safeParse({ type: 'DNI', number: '12345678A' }).success).toBe(false);
    expect(idDocumentProblem('NIE', 'X1234567L')).toBeNull();
    expect(idDocumentProblem('NIE', 'X1234567A')).toMatch(/letra/);
    expect(idDocumentProblem('PASAPORTE', 'PAB123456')).toBeNull();
    expect(idDocumentProblem('PASAPORTE', 'P1')).toMatch(/pasaporte/);
  });
});
