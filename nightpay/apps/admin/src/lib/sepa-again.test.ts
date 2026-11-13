import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-errors';
import { SepaAlreadyExportedError, downloadSepaAsking, sepaAgainQuestion, sepaFile } from './sepa-again';

const TZ = 'Europe/Madrid';
const XML = '<?xml version="1.0"?><Document/>';

const problem = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'Conflict', status, ...body }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

describe('el fichero SEPA ya descargado (409 ALREADY_EXPORTED)', () => {
  it('el fichero, tal cual; el 409 con cuándo y quién; otro error, el de siempre', async () => {
    expect(await (await sepaFile(new Response(XML, { status: 200 }))).text()).toBe(XML);
    const already = await sepaFile(
      problem(409, { code: 'ALREADY_EXPORTED', detail: 'Este fichero ya se descargó', exportedAt: '2027-06-29T19:30:00.000Z', exportedBy: 'Paco' }),
    ).catch((e: unknown) => e);
    expect(already).toBeInstanceOf(SepaAlreadyExportedError);
    expect(already).toMatchObject({ exportedAt: '2027-06-29T19:30:00.000Z', exportedBy: 'Paco' });
    const other = await sepaFile(problem(409, { code: 'NO_DEBTOR_IBAN', detail: 'El local no tiene su cuenta' })).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(ApiError);
    expect(other).not.toBeInstanceOf(SepaAlreadyExportedError);
    expect(other).toMatchObject({ code: 'NO_DEBTOR_IBAN' });
  });

  it('la pregunta: cuándo (en la hora del local) y quién, y el aviso de pagar dos veces', () => {
    const text = sepaAgainQuestion({ exportedAt: '2027-06-29T19:30:00.000Z', exportedBy: 'Paco' }, TZ);
    expect(text).toMatch(/^Ya descargaste este fichero el .*21:30.* por Paco\. ¿Descargarlo otra vez\? Cuidado: si lo subes dos veces al banco, pagarás dos veces\.$/);
    expect(sepaAgainQuestion({ exportedAt: '2027-06-29T19:30:00.000Z', exportedBy: null }, TZ)).not.toContain(' por ');
  });

  it('pregunta y, con un sí, lo pide otra vez (again); con un no, nada', async () => {
    const info = { exportedAt: '2027-06-29T19:30:00.000Z', exportedBy: 'Paco' };
    const blob = new Blob([XML]);
    const download = vi.fn(async (again: boolean) => {
      if (!again) throw new SepaAlreadyExportedError('ya', info);
      return blob;
    });
    const yes = vi.fn(() => true);
    expect(await downloadSepaAsking(download, yes, TZ)).toBe(blob);
    expect(yes).toHaveBeenCalledWith(sepaAgainQuestion(info, TZ));
    expect(download.mock.calls).toEqual([[false], [true]]);

    download.mockClear();
    expect(await downloadSepaAsking(download, () => false, TZ)).toBeNull();
    expect(download.mock.calls).toEqual([[false]]);

    // La primera vez, sin preguntar nada.
    const first = vi.fn(async () => blob);
    const ask = vi.fn(() => true);
    expect(await downloadSepaAsking(first, ask, TZ)).toBe(blob);
    expect(ask).not.toHaveBeenCalled();
  });
});
