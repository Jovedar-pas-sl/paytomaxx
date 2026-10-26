import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF_ONBOARDING_ALREADY_SAVED } from '@nightpay/contracts';
import { SelfOnboardingSavedError, fetchSelfOnboardingProfile, submitSelfOnboarding } from '../../../lib/api';
import { ONBOARDING_LINK_NOTE, savedScreen } from './onboarding-copy';

/** El API contesta esto a la siguiente petición. */
function apiReplies(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('el enlace de alta es de un solo uso', () => {
  const saved = { status: 409, code: SELF_ONBOARDING_ALREADY_SAVED, detail: 'Tus datos ya se guardaron con este enlace.' };

  it('el pie del formulario no promete editar 72 h: dice que al guardar deja de valer', () => {
    expect(ONBOARDING_LINK_NOTE).not.toMatch(/72/);
    expect(ONBOARDING_LINK_NOTE).toMatch(/deja de valer/);
    expect(ONBOARDING_LINK_NOTE).toMatch(/enlace nuevo/);
  });

  it('se perdió la respuesta y reintenta: «ya se guardó» (no «Token inválido»)', async () => {
    apiReplies(409, saved);
    await expect(submitSelfOnboarding('tok', { phone: '600000000' })).rejects.toBeInstanceOf(SelfOnboardingSavedError);
  });

  it('vuelve a abrir el enlace ya usado: también «ya se guardó»', async () => {
    apiReplies(409, saved);
    await expect(fetchSelfOnboardingProfile('tok')).rejects.toBeInstanceOf(SelfOnboardingSavedError);
  });

  it('enlace caducado o rehecho por el admin (401) y otros 409: como antes', async () => {
    apiReplies(401, { status: 401, detail: 'Token inválido o ya rotado' });
    const expired = await fetchSelfOnboardingProfile('tok').catch((e: unknown) => e);
    expect(expired).not.toBeInstanceOf(SelfOnboardingSavedError);
    expect((expired as Error).message).toMatch(/expiró/);
    apiReplies(409, { status: 409, code: 'OTRA_COSA', detail: 'Otra cosa' });
    await expect(submitSelfOnboarding('tok', {})).rejects.not.toBeInstanceOf(SelfOnboardingSavedError);
  });

  it('la pantalla final: guardado ahora o ya guardado antes, y en las dos cómo cambiar algo', () => {
    expect(savedScreen('now').title).toBe('✓ Guardado');
    expect(savedScreen('before').title).toBe('✓ Ya estaba guardado');
    expect(savedScreen('before').text).toMatch(/ya se guardaron con este enlace/);
    for (const kind of ['now', 'before'] as const) expect(savedScreen(kind).text).toMatch(/enlace nuevo/);
  });
});
