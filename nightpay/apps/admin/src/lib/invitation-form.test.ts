import { describe, expect, it } from 'vitest';
import { DEFAULT_INVITATION_RULES } from '@nightpay/contracts';
import { REFERENCE_SPLIT, invitationExample, showCamareroShare, shareFromDraft, shareToDraft } from './invitation-form';

describe('Ajustes → Invitaciones', () => {
  it('el % y los € por copa, de ida y vuelta', () => {
    expect(shareToDraft({ kind: 'PERCENT', bps: 1250 })).toEqual({ kind: 'PERCENT', value: '12,5' });
    expect(shareFromDraft({ kind: 'PERCENT', value: '12,5' }, 'la chica')).toEqual({ ok: true, share: { kind: 'PERCENT', bps: 1250 } });
    expect(shareFromDraft({ kind: 'PERCENT', value: '50 %' }, 'la chica')).toEqual({ ok: true, share: { kind: 'PERCENT', bps: 5000 } });
    expect(shareToDraft({ kind: 'FIXED', cents: 500 })).toEqual({ kind: 'FIXED', value: '5,00' });
    expect(shareFromDraft({ kind: 'FIXED', value: '5' }, 'el camarero')).toEqual({ ok: true, share: { kind: 'FIXED', cents: 500 } });
  });

  it('0 vale (no le toca nada); lo que no cuadra se dice en español', () => {
    expect(shareFromDraft({ kind: 'FIXED', value: '0' }, 'el camarero')).toEqual({ ok: true, share: { kind: 'FIXED', cents: 0 } });
    expect(shareFromDraft({ kind: 'PERCENT', value: '0' }, 'el camarero')).toEqual({ ok: true, share: { kind: 'PERCENT', bps: 0 } });
    expect(shareFromDraft({ kind: 'PERCENT', value: '120' }, 'la chica')).toEqual({
      ok: false,
      problem: 'La parte de la chica es un % entre 0 y 100.',
    });
    expect(shareFromDraft({ kind: 'FIXED', value: 'mucho' }, 'el camarero')).toMatchObject({ ok: false });
  });

  it('el ejemplo que ve el dueño (las de fábrica: la chica 50 % y el resto, del local)', () => {
    const text = invitationExample(DEFAULT_INVITATION_RULES, 2000).replace(/\u00a0/g, ' ');
    expect(text).toBe('De una copa con invitación de 20,00 €: 10,00 € para la chica y 10,00 € para el local.');
  });

  it('un local con parte para el camarero (guardada antes) la ve en el ejemplo', () => {
    const rules = { chica: { kind: 'PERCENT' as const, bps: 5000 }, camarero: { kind: 'FIXED' as const, cents: 300 } };
    const text = invitationExample(rules, 2000).replace(/\u00a0/g, ' ');
    expect(text).toBe('De una copa con invitación de 20,00 €: 10,00 € para la chica, 3,00 € para el camarero que la cobra y 7,00 € para el local.');
  });

  it('la parte del camarero, fuera del camino: solo se enseña abierta si el local le da algo', () => {
    expect(showCamareroShare({ kind: 'PERCENT', value: '0' })).toBe(false);
    expect(showCamareroShare({ kind: 'FIXED', value: '0,00' })).toBe(false);
    expect(showCamareroShare({ kind: 'PERCENT', value: '50' })).toBe(true);
    expect(showCamareroShare({ kind: 'FIXED', value: '3' })).toBe(true);
    // Tecleando (vacío o a medias) no se cierra de golpe.
    expect(showCamareroShare({ kind: 'PERCENT', value: '' })).toBe(true);
  });

  it('el reparto de referencia: 10 € la chica y 10 € el local de una copa de 20 €', () => {
    expect(REFERENCE_SPLIT).toEqual({ chica: { kind: 'PERCENT', value: '50' }, camarero: { kind: 'PERCENT', value: '0' } });
    const chica = shareFromDraft(REFERENCE_SPLIT.chica, 'la chica');
    const camarero = shareFromDraft(REFERENCE_SPLIT.camarero, 'el camarero');
    if (!chica.ok || !camarero.ok) throw new Error('el de referencia vale');
    expect(invitationExample({ chica: chica.share, camarero: camarero.share }, 2000).replace(/\u00a0/g, ' ')).toBe(
      'De una copa con invitación de 20,00 €: 10,00 € para la chica y 10,00 € para el local.',
    );
  });
});
