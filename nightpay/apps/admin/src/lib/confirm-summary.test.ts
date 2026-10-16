import { describe, expect, it } from 'vitest';
import { maskMiddle, maskPayoutTarget, payoutSummary, refundSummary, walletPayoutSummary } from './confirm-summary';

// Intl usa espacio duro antes de "€".
const eur = (s: string) => s.replace(/\u00a0/g, ' ');

describe('maskMiddle', () => {
  it('deja el principio y el final', () => {
    expect(maskMiddle('TXYZxQwUVqHbvHvgrkqz6T6oyhqcKp9f2a')).toBe('TXYZ…9f2a');
    expect(maskMiddle('0x1234567890abcdef1234567890abcdef12349f2a', 4, 4)).toBe('0x12…9f2a');
  });

  it('lo corto, tal cual', () => {
    expect(maskMiddle('abc123')).toBe('abc123');
    expect(maskMiddle('123456789')).toBe('123456789');
    expect(maskMiddle('')).toBe('');
  });
});

describe('maskPayoutTarget', () => {
  it('IBAN: país y control, y los 4 últimos (sin espacios)', () => {
    expect(maskPayoutTarget('ES91 2100 0418 4502 0005 1332')).toBe('ES91…1332');
  });

  it('email: primera letra y el dominio', () => {
    expect(maskPayoutTarget('ana.lopez@ejemplo.com')).toBe('a…@ejemplo.com');
  });

  it('direcciones cripto y lo demás: principio…final', () => {
    expect(maskPayoutTarget('  TXYZxQwUVqHbvHvgrkqz6T6oyhqcKp9f2a ')).toBe('TXYZ…9f2a');
    expect(maskPayoutTarget('+34600111222')).toBe('+346…1222');
  });
});

describe('refundSummary', () => {
  it('con tarjeta conocida', () => {
    expect(eur(refundSummary({ amountCents: 4500, cardLast4: '4242', venueName: 'Luna' }))).toBe(
      'Vas a devolver 45,00 € a la tarjeta ••4242 desde Luna. No se puede deshacer.',
    );
  });

  it('sin tarjeta', () => {
    expect(eur(refundSummary({ amountCents: 1000, cardLast4: null, venueName: 'Luna' }))).toBe(
      'Vas a devolver 10,00 € al cliente de este cobro desde Luna. No se puede deshacer.',
    );
  });
});

describe('payoutSummary', () => {
  it('cripto con dirección enmascarada', () => {
    expect(
      eur(
        payoutSummary({
          amountCents: 34000,
          operatorName: 'Ana',
          methodLabel: 'USDT TRC20',
          target: 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKp9f2a',
          venueName: 'Luna',
        }),
      ),
    ).toBe('Vas a dar por pagados 340,00 € a Ana en USDT TRC20 a TXYZ…9f2a desde Luna. No se puede deshacer.');
  });

  it('sin método ni dirección', () => {
    expect(
      eur(payoutSummary({ amountCents: 5000, operatorName: 'Ana', methodLabel: null, target: null, venueName: 'Luna' })),
    ).toBe('Vas a dar por pagados 50,00 € a Ana desde Luna. No se puede deshacer.');
  });
});

describe('walletPayoutSummary', () => {
  it('efectivo y tarjeta', () => {
    expect(eur(walletPayoutSummary({ amountCents: 2300, method: 'CASH', code: '4F7K', venueName: 'Luna' }))).toBe(
      'Vas a devolver 23,00 € en efectivo del saldo 4F7K desde Luna. No se puede deshacer.',
    );
    expect(eur(walletPayoutSummary({ amountCents: 2300, method: 'CARD', code: null, venueName: 'Luna' }))).toBe(
      'Vas a devolver 23,00 € a la tarjeta del saldo desde Luna. No se puede deshacer.',
    );
  });
});
