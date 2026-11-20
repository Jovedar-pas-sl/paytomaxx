import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MyStall } from '@nightpay/contracts';
import { MyStallCard } from '../components/party/PartySettings';
import { MY_STALL_PATH, loadMyStall, saveMyStallOpen } from './party-my-stall';

// OxioParty · «Abierta ahora» en Ajustes (GET/PATCH /v1/party/my-stall): quien
// tiene caseta la abre o la cierra; sin caseta (o si falla al cargar), no sale.

const STALL: MyStall = { id: '2d1f4c3a-9b8e-4f7a-8c6d-5e4f3a2b1c0d', name: 'Peña El Cántaro', openNow: false };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('la caseta de quien entra: pedirla', () => {
  it('pide /v1/party/my-stall y devuelve su caseta; sin caseta, null', async () => {
    const fetcher = vi.fn(async () => json({ stall: STALL }));
    await expect(loadMyStall(fetcher)).resolves.toEqual(STALL);
    expect(fetcher).toHaveBeenCalledWith(MY_STALL_PATH, {});
    await expect(loadMyStall(async () => json({ stall: null }))).resolves.toBeNull();
  });

  it('si falla, null y sin lanzar: 404 (OxioPay), 403, 500, sin red o un cuerpo raro', async () => {
    for (const status of [404, 403, 500]) await expect(loadMyStall(async () => json({ code: 'X' }, status))).resolves.toBeNull();
    await expect(
      loadMyStall(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).resolves.toBeNull();
    await expect(loadMyStall(async () => json({ stall: { ...STALL, openNow: 'sí' } }))).resolves.toBeNull();
    await expect(loadMyStall(async () => json(null))).resolves.toBeNull();
  });
});

describe('abrirla o cerrarla', () => {
  it('manda cómo queda (PATCH { openNow }) y devuelve la caseta guardada', async () => {
    const fetcher = vi.fn(async () => json({ stall: { ...STALL, openNow: true } }));
    await expect(saveMyStallOpen(fetcher, true)).resolves.toEqual({ ...STALL, openNow: true });
    expect(fetcher).toHaveBeenCalledWith(MY_STALL_PATH, { method: 'PATCH', body: JSON.stringify({ openNow: true }) });
  });

  it('si el API dice que no (sin caseta, 409), su frase', async () => {
    const fetcher = async () => json({ code: 'NO_STALL', message: 'No tienes caseta: pide a la organización que te dé una.' }, 409);
    await expect(saveMyStallOpen(fetcher, true)).rejects.toThrow('No tienes caseta');
  });
});

describe('la tarjeta en Ajustes', () => {
  it('con caseta: su nombre y «Abierta» / «Cerrada» marcados como está', () => {
    const html = renderToStaticMarkup(createElement(MyStallCard, { initial: STALL }));
    expect(html).toContain('Peña El Cántaro');
    expect(html).toContain('role="group" aria-label="Abierta ahora"');
    expect(html).toMatch(/aria-pressed="false"[^>]*>Abierta</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Cerrada</);
  });

  it('sin caseta, nada', () => {
    expect(renderToStaticMarkup(createElement(MyStallCard, { initial: null }))).toBe('');
  });
});
