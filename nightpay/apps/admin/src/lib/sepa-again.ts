// OxioParty · ficheros SEPA ya descargados (el del cierre y el de las
// transferencias de devolución). El API responde 409 ALREADY_EXPORTED con
// cuándo y quién; el panel lo pregunta y, si se confirma, lo pide otra vez
// con ?again=1. Subirlo dos veces al banco paga dos veces.

import { ALREADY_EXPORTED_CODE, type SepaAlreadyExported } from '@nightpay/contracts';
import { formatDateTime } from './dates';
import { apiError } from './http';

/** El 409 ALREADY_EXPORTED, con cuándo y quién lo descargó la última vez. */
export class SepaAlreadyExportedError extends Error implements SepaAlreadyExported {
  override name = 'SepaAlreadyExportedError';
  readonly exportedAt: string;
  readonly exportedBy: string | null;

  constructor(message: string, info: SepaAlreadyExported) {
    super(message);
    this.exportedAt = info.exportedAt;
    this.exportedBy = info.exportedBy;
  }
}

/** El fichero; si no, el error del API (el 409 ALREADY_EXPORTED, como SepaAlreadyExportedError). */
export async function sepaFile(res: Response): Promise<Blob> {
  if (res.ok) return res.blob();
  const copy = res.clone();
  const err = await apiError(res);
  if (err.code !== ALREADY_EXPORTED_CODE) throw err;
  const body = (await copy.json().catch(() => null)) as Partial<Record<keyof SepaAlreadyExported, unknown>> | null;
  throw new SepaAlreadyExportedError(err.message, {
    exportedAt: typeof body?.exportedAt === 'string' ? body.exportedAt : '',
    exportedBy: typeof body?.exportedBy === 'string' && body.exportedBy.trim() ? body.exportedBy : null,
  });
}

/** La pregunta antes de descargarlo otra vez (la fecha y la hora, en las del local). */
export function sepaAgainQuestion(info: SepaAlreadyExported, timeZone: string): string {
  const when = info.exportedAt ? `el ${formatDateTime(info.exportedAt, timeZone, 'datetime')}` : 'antes';
  const who = info.exportedBy ? ` por ${info.exportedBy}` : '';
  return `Ya descargaste este fichero ${when}${who}. ¿Descargarlo otra vez? Cuidado: si lo subes dos veces al banco, pagarás dos veces.`;
}

/**
 * Descarga con la pregunta: si ya se descargó, pregunta (confirm) y, con un
 * sí, lo pide otra vez (`again`). Con un no, null (no se hace nada).
 */
export async function downloadSepaAsking(
  download: (again: boolean) => Promise<Blob>,
  ask: (question: string) => boolean,
  timeZone: string,
): Promise<Blob | null> {
  try {
    return await download(false);
  } catch (err) {
    if (!(err instanceof SepaAlreadyExportedError)) throw err;
    if (!ask(sepaAgainQuestion(err, timeZone))) return null;
    return download(true);
  }
}
