import { describe, expect, it } from 'vitest';
import type { PartyRefundRow, PulseraRow, WalletCardRow } from '@nightpay/contracts';
import { REPLACE_PULSERA_BODY, UNPAIR_TEXT, preparePulserasText, replacePulseraText, splitQuestion, walletBlockText, walletFichaBlockText } from './confirm-text';
import { fichaConfirmText } from './fichas';
import { blockConfirmText, refundCancelConfirm, refundDoneConfirm } from './party-asistente';

// Idea 49: cada pregunta gris de hoy (window.confirm), partida para la ventana
// nueva. Las mismas palabras: la pregunta arriba y la consecuencia debajo.

describe('splitQuestion', () => {
  it('corta tras el primer «?»: la pregunta es el título; el resto, el cuerpo', () => {
    expect(splitQuestion('¿Bloquear la ficha 522? Ya no podrá pagar con ella.')).toEqual({ title: '¿Bloquear la ficha 522?', body: 'Ya no podrá pagar con ella.' });
    expect(splitQuestion('¿Una? ¿Y otra?')).toEqual({ title: '¿Una?', body: '¿Y otra?' });
  });

  it('sin cuerpo, solo título; sin «?», todo es título', () => {
    expect(splitQuestion('¿Bloquear P-0001 y pasar su saldo a P-0002?')).toEqual({ title: '¿Bloquear P-0001 y pasar su saldo a P-0002?' });
    expect(splitQuestion('Bloquear')).toEqual({ title: 'Bloquear' });
  });
});

describe('cada texto de hoy, partido', () => {
  it('WalletFichaModal', () => {
    expect(splitQuestion(walletFichaBlockText('522'))).toEqual({
      title: '¿Bloquear la ficha 522?',
      body: 'Ya no podrá pagar con ella (el saldo sigue: se le puede dar otra).',
    });
  });

  it('WalletsPanel, con código y sin él', () => {
    expect(splitQuestion(walletBlockText('K7M2'))).toEqual({ title: '¿Bloquear la ficha de K7M2?', body: 'Ya no servirá para pagar (el saldo sigue).' });
    expect(splitQuestion(walletBlockText(null))).toEqual({ title: '¿Bloquear la ficha de este saldo?', body: 'Ya no servirá para pagar (el saldo sigue).' });
  });

  it('TerminalsPanel', () => {
    expect(splitQuestion(UNPAIR_TEXT)).toEqual({
      title: '¿Desvincular la app de este datáfono?',
      body: 'No recibirá cobros hasta que lo vuelvas a vincular.',
    });
  });

  it('PulserasSection: preparar, bloquear y pasar el saldo', () => {
    expect(splitQuestion(preparePulserasText(100))).toEqual({ title: '¿Preparar 100 pulseras nuevas?', body: 'Salen con números seguidos, ya en el stock.' });
    expect(splitQuestion(replacePulseraText('P-0412', 'P-0413'))).toEqual({ title: '¿Bloquear P-0412 y pasar su saldo a P-0413?' });
    expect(REPLACE_PULSERA_BODY).toBe('Deja de pagar al momento y su saldo pasa entero a la nueva.');
    const row = { label: 'P-0412' } as PulseraRow;
    expect(splitQuestion(blockConfirmText(row))).toEqual({
      title: '¿Bloquear la pulsera P-0412?',
      body: 'Deja de pagar al momento (también sin PIN). El saldo no se pierde: luego se pasa a otra pulsera.',
    });
  });

  it('fichaConfirmText: bloquear y perdida, con saldo o sin él, con número o con su pista', () => {
    const withUid = { uid: '04A1B2C3', tokenHint: 'ab12', walletCode: 'K7M2' } as WalletCardRow;
    const bare = { uid: null, tokenHint: 'ab12', walletCode: null } as unknown as WalletCardRow;
    for (const row of [withUid, bare]) {
      const block = splitQuestion(fichaConfirmText(row, 'block'));
      expect(block.title).toMatch(/^¿Bloquear la ficha .+\?$/);
      expect(block.body).toBe('Ya no servirá para pagar. El saldo sigue (código + PIN).');
      const lost = splitQuestion(fichaConfirmText(row, 'lost'));
      expect(lost.title).toMatch(/^¿Marcar la ficha .+ como perdida\?$/);
      expect(lost.body).toBe('Ya no servirá para pagar y sale del stock. El saldo sigue (código + PIN).');
    }
    expect(splitQuestion(fichaConfirmText(withUid, 'block')).title).toContain('(del saldo K7M2)');
    expect(splitQuestion(fichaConfirmText(bare, 'block')).title).toBe('¿Bloquear la ficha ab12…?');
  });

  it('refundDoneConfirm (tarjeta y transferencia) y refundCancelConfirm', () => {
    const card = { method: 'CARD', amountCents: 1200, pulsera: 'P-0001', walletCode: null, holderName: null, ibanHint: null } as unknown as PartyRefundRow;
    const transfer = { ...card, method: 'TRANSFER', holderName: 'Ana Pérez', ibanHint: 'ES91 •••• 1332' } as PartyRefundRow;
    const doneBody = 'Al marcarla «Hecha», ese dinero sale de su saldo.';
    const c = splitQuestion(refundDoneConfirm(card));
    expect(c.title).toMatch(/^¿Ya devolviste 12.* a la tarjeta de P-0001 en el portal del banco\?$/);
    expect(c.body).toBe(doneBody);
    const t = splitQuestion(refundDoneConfirm(transfer));
    expect(t.title).toMatch(/^¿Ya enviaste la transferencia de 12.* a Ana Pérez \(ES91 •••• 1332\) \(P-0001\)\?$/);
    expect(t.body).toBe(doneBody);
    for (const row of [card, { ...card, pulsera: null, walletCode: null } as PartyRefundRow]) {
      const x = splitQuestion(refundCancelConfirm(row));
      expect(x.title).toMatch(/^¿Anular la devolución de 12.* \((P-0001|sin pulsera)\)\?$/);
      expect(x.body).toBe('No sale nada y su saldo vuelve a poder gastarse.');
    }
  });
});
