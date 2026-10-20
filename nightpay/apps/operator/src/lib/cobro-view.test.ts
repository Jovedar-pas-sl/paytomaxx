import { describe, expect, it } from 'vitest';
import {
  failReasonOf,
  invitationSplit,
  methodLabel,
  paidMeta,
  pinExpected,
  pinFootnote,
  pinWarning,
  soloLabel,
  splitCells,
  whoLine,
} from './cobro-view';

const NIGHT = { nfcNoPinMaxCents: 2000 };
/** Intl pone un espacio duro entre la cifra y el «€». */
const NBSP = String.fromCharCode(160);
const sp = (s: string): string => s.split(NBSP).join(' ');

describe('esperando y resultado', () => {
  it('el PIN, solo por encima del tope sin PIN del local', () => {
    expect(pinExpected(2000, NIGHT)).toBe(false);
    expect(pinExpected(2001, NIGHT)).toBe(true);
    expect(sp(pinWarning(NIGHT))).toBe('Más de 20 €: el cliente pondrá su PIN');
    expect(pinWarning({ nfcNoPinMaxCents: 0 })).toBe('El cliente pondrá su PIN');
    expect(sp(pinFootnote(NIGHT))).toBe('Tápalo con la mano. Más de 20 € pide PIN.');
    expect(pinFootnote({ nfcNoPinMaxCents: 0 })).toBe('Tápalo con la mano.');
  });

  it('PAGADO: quién, qué, cómo y la hora de Madrid', () => {
    const at = new Date('2026-10-20T23:10:00Z');
    expect(paidMeta({ who: 'Carlos', what: '2 copas', method: 'nfc_nopin', at })).toBe('Carlos · 2 copas · NFC · 01:10');
    expect(paidMeta({ who: null, what: null, method: 'card', at })).toBe('Tarjeta · 01:10');
    expect(methodLabel('pin')).toBe('NFC + PIN');
    expect(methodLabel(null)).toBeNull();
  });

  it('NO PAGADO: la razón en una frase (saldo insuficiente con lo que tiene y lo que falta)', () => {
    const poor = failReasonOf({ code: 'WALLET_INSUFFICIENT' }, { totalCents: 5000, wallet: { code: 'K7Q-4M2', balanceCents: 3000 } });
    expect({ ...poor, sentence: sp(poor.sentence) }).toEqual({ title: 'Saldo insuficiente', sentence: 'Tiene 30 € en K7Q-4M2. Faltan 20 €.' });
    expect(failReasonOf({ code: 'WALLET_INSUFFICIENT' }, { totalCents: 5000 }).sentence).toMatch(/No le llega/);
    expect(failReasonOf({ code: 'WALLET_BLOCKED' }).title).toBe('Saldo bloqueado');
    expect(failReasonOf({ code: 'CHARGE_OTHER_VENUE' }).title).toBe('Saldo de otro local');
    expect(failReasonOf({ code: 'CARD_DECLINED' }).title).toBe('Tarjeta rechazada');
    expect(failReasonOf({ code: 'WALLET_CLOSED' }).title).toBe('Saldo cerrado');
    expect(failReasonOf({ code: 'CHARGE_EXPIRED' }).title).toBe('Ha caducado');
    expect(failReasonOf({ code: 'X', message: 'Algo raro' })).toEqual({ title: 'No se ha cobrado', sentence: 'Algo raro' });
    expect(failReasonOf(null).sentence).toBe('No se ha podido cobrar.');
  });

  it('el reparto de una invitación: Nerea 10 € y Barra (Carlos) 10 € (la del camarero, solo si es camarero)', () => {
    const rules = { chica: { kind: 'FIXED' as const, cents: 1000 }, camarero: { kind: 'PERCENT' as const, bps: 5000 } };
    const split = invitationSplit(rules, 2000, true);
    expect(split).toEqual({ chicaCents: 1000, barraCents: 1000, localCents: 0 });
    expect(splitCells(split, { chica: 'Nerea', barra: 'Barra (Carlos)' })).toEqual([
      { label: 'Nerea', cents: 1000 },
      { label: 'Barra (Carlos)', cents: 1000 },
    ]);
    // El dueño la cobra: lo que no es de la chica, del local.
    const owner = invitationSplit(rules, 2000, false);
    expect(splitCells(owner, { chica: 'La chica', barra: 'La barra' })).toEqual([
      { label: 'La chica', cents: 1000 },
      { label: 'Local', cents: 1000 },
    ]);
    // Las tres partes.
    const three = invitationSplit({ chica: { kind: 'PERCENT', bps: 5000 }, camarero: { kind: 'FIXED', cents: 300 } }, 2000, true);
    expect(splitCells(three, { chica: 'Nerea', barra: 'Barra' }).map((c) => c.cents)).toEqual([1000, 300, 700]);
  });

  it('cabecera y copa sola', () => {
    expect(whoLine('Carlos', 'WAITER')).toBe('Carlos · camarero');
    expect(whoLine('Lola', 'OPERATOR')).toBe('Lola · chica');
    expect(whoLine(null, 'OWNER')).toBe('dueño');
    expect(soloLabel('Copa')).toBe('Copa sola');
    expect(soloLabel('Botella')).toBe('Botella');
  });
});
