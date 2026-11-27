import {
  ID_DOCUMENT_TYPES,
  maskIdDocumentNumber,
  type IdDocumentInput,
  type IdDocumentType,
} from '@nightpay/contracts';
import { openPayoutValue, sealPayoutValue } from './payout-account-crypto';

/**
 * El documento de la compañera (cobro por el encargado, fase 3): el tipo y el
 * número, cada uno cifrado como la cuenta de cobro (pa1:…, ENCRYPTION_KEK, su
 * campo y su persona: copiado a otra persona o a otro campo, no se abre). El
 * panel lo enseña tapado; entero, solo «Ver documento» del dueño con 2FA.
 * Lógica pura.
 */

export interface IdDocumentRow {
  id: string;
  idDocumentType?: string | null;
  idDocumentNumber?: string | null;
}

/** Lo que se guarda en users: cifrado, o los dos a null (quitarlo, o la baja). */
export function idDocumentData(
  userId: string,
  doc: IdDocumentInput | null,
  kek: string | undefined = process.env.ENCRYPTION_KEK,
): { idDocumentType: string | null; idDocumentNumber: string | null } {
  if (!doc) return { idDocumentType: null, idDocumentNumber: null };
  return {
    idDocumentType: sealPayoutValue(doc.type, { userId, field: 'idDocumentType' }, kek),
    idDocumentNumber: sealPayoutValue(doc.number, { userId, field: 'idDocumentNumber' }, kek),
  };
}

/** Entero (solo en memoria). Lanza si no se puede abrir (otra clave, u otra persona). Null sin documento. */
export function openIdDocument(
  row: IdDocumentRow,
  kek: string | undefined = process.env.ENCRYPTION_KEK,
): { type: IdDocumentType; number: string } | null {
  if (!row.idDocumentType || !row.idDocumentNumber) return null;
  const type = openPayoutValue(row.idDocumentType, { userId: row.id, field: 'idDocumentType' }, kek);
  if (!(ID_DOCUMENT_TYPES as readonly string[]).includes(type)) throw new Error('Tipo de documento desconocido');
  const number = openPayoutValue(row.idDocumentNumber, { userId: row.id, field: 'idDocumentNumber' }, kek);
  return { type: type as IdDocumentType, number };
}

/** Para el panel: el tipo y el número tapado. Si no se puede abrir, solo «••••». */
export function idDocumentView(
  row: IdDocumentRow,
  kek: string | undefined = process.env.ENCRYPTION_KEK,
): { idDocumentType: IdDocumentType | null; idDocumentMasked: string | null } {
  try {
    const doc = openIdDocument(row, kek);
    return doc ? { idDocumentType: doc.type, idDocumentMasked: maskIdDocumentNumber(doc.number) } : { idDocumentType: null, idDocumentMasked: null };
  } catch {
    return { idDocumentType: null, idDocumentMasked: '••••' };
  }
}
