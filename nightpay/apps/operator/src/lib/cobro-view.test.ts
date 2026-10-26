import { describe, expect, it } from 'vitest';
import { invitationRulesOf } from '@nightpay/contracts';
import {
  CHECKING_TEXT,
  failReasonOf,
  invitationSplit,
  methodLabel,
  paidAmounts,
  paidMeta,
  pinExpected,
  pinFootnote,
  pinWarning,
  splitCells,
  tipLine,
  waitingLiveText,
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

  it('una copa con invitación en un local sin partes guardadas: 20 € = la chica 10 € y el local 10 € (la cobre quien la cobre)', () => {
    for (const waiter of [true, false]) {
      const split = invitationSplit(invitationRulesOf(null), 2000, waiter);
      expect(split).toEqual({ chicaCents: 1000, barraCents: 0, localCents: 1000 });
      expect(splitCells(split, { chica: 'Nerea', barra: 'Barra (Carlos)' })).toEqual([
        { label: 'Nerea', cents: 1000 },
        { label: 'Local', cents: 1000 },
      ]);
    }
  });

  it('cabecera', () => {
    expect(whoLine('Carlos', 'WAITER')).toBe('Carlos · camarero');
    expect(whoLine('Lola', 'OPERATOR')).toBe('Lola · chica');
    expect(whoLine(null, 'OWNER')).toBe('dueño');
  });
});

describe('el PAGADO con propina (D7)', () => {
  it('con tarjeta: lo vendido + la propina que eligió el cliente', () => {
    const a = paidAmounts({ totalCents: 3300 }, { method: 'card', tipCents: 200 });
    expect(a).toEqual({ baseCents: 3300, tipCents: 200, totalCents: 3500 });
    expect(sp(JSON.stringify(tipLine(a)))).toBe(JSON.stringify({ base: '33 €', tip: '2 €' }));
  });

  it('con tarjeta y una propina ya puesta en la cuenta: no se suma dos veces', () => {
    // La cuenta: 33 € + 2 € de propina (total 35 €); el cliente deja los 2 € marcados.
    expect(paidAmounts({ totalCents: 3500, tipCents: 200 }, { method: 'card', tipCents: 200 })).toEqual({
      baseCents: 3300,
      tipCents: 200,
      totalCents: 3500,
    });
    // O la cambia a 5 €.
    expect(paidAmounts({ totalCents: 3500, tipCents: 200 }, { method: 'card', tipCents: 500 }).totalCents).toBe(3800);
  });

  it('con el saldo: la propina de la cuenta (no se puede cambiar)', () => {
    expect(paidAmounts({ totalCents: 3500, tipCents: 200 }, { method: 'nfc_nopin', tipCents: 0 })).toEqual({
      baseCents: 3300,
      tipCents: 200,
      totalCents: 3500,
    });
  });

  it('con tarjeta y la propina aún sin saber (solo llegó el estado): el total de la cuenta, sin línea de propina', () => {
    const a = paidAmounts({ totalCents: 3500, tipCents: 200 }, { method: 'card', tipCents: null });
    expect(a).toEqual({ baseCents: 3300, tipCents: null, totalCents: 3500 });
    expect(tipLine(a)).toBeNull();
    // Sin propina en la cuenta, igual: lo que se cobró.
    expect(paidAmounts({ totalCents: 3300 }, { method: 'card', tipCents: null }).totalCents).toBe(3300);
  });

  it('sin propina no hay línea; con céntimos, con ellos', () => {
    expect(tipLine(paidAmounts({ totalCents: 1200 }, { method: 'card', tipCents: 0 }))).toBeNull();
    expect(sp(tipLine({ baseCents: 1250, tipCents: 150, totalCents: 1400 })!.tip)).toBe('1,50 €');
  });
});

describe('la espera «viva»', () => {
  it('dice que sigue esperando y avisa al acabarse el tiempo (solo al cambiar de fase)', () => {
    expect(waitingLiveText('ok')).toBe('Esperando el pago…');
    expect(waitingLiveText('ending')).toBe('Queda menos de un minuto');
    expect(waitingLiveText('over')).toBe('Comprobando…');
  });

  it('tras un fallo de red al pagar con el NFC o el PIN, «comprobando si se ha cobrado» (APP-02)', () => {
    expect(waitingLiveText('ok', true)).toBe(CHECKING_TEXT);
    expect(waitingLiveText('ending', true)).toBe(CHECKING_TEXT);
    expect(CHECKING_TEXT).toMatch(/^Comprobando si se ha cobrado/);
    expect(CHECKING_TEXT).not.toMatch(/No se ha cobrado/);
  });
});
