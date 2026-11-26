// Menú → Este aparato → «Prueba de lectura»: lo que se dice de la ficha leída.
// No cobra ni consulta nada: solo lo que lleva la ficha y su número de serie.

import type { TagRead } from './nfc';

export interface TestRead {
  ok: boolean;
  text: string;
}

export function testReadResult(read: Pick<TagRead, 'token' | 'blank' | 'uid'>): TestRead {
  const kind = read.token ? 'ficha de OxioPay' : read.blank ? 'ficha en blanco' : 'tiene otra cosa grabada';
  const serial = read.uid ? ` · nº de serie ${read.uid}` : '';
  return { ok: true, text: `Leída · ${kind}${serial}` };
}
