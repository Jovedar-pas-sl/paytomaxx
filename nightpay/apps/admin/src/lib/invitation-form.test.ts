import { describe, expect, it } from 'vitest';
import { DEFAULT_INVITATION_RULES } from '@nightpay/contracts';
import { invitationExample, shareFromDraft, shareToDraft } from './invitation-form';

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

  it('el ejemplo que ve el dueño (las de fábrica, maqueta 2.6: chica 50 %, camarero 50 %)', () => {
    const text = invitationExample(DEFAULT_INVITATION_RULES, 2000).replace(/\u00a0/g, ' ');
    expect(text).toBe('De una invitación de 20,00 €: 10,00 € para la chica, 10,00 € para el camarero y 0,00 € para el local.');
  });
});
