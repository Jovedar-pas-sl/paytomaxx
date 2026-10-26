import { describe, expect, it } from 'vitest';
import { cashVoidBody, cashVoidDoneText, cashVoidOutText, cashVoidProblem } from './cash-void';

describe('anular una recarga en efectivo', () => {
  it('hace falta el motivo y el código 2FA (siempre)', () => {
    expect(cashVoidProblem('', '123456')).toMatch(/por qué/);
    expect(cashVoidProblem('ok', '123456')).toMatch(/por qué/);
    expect(cashVoidProblem('mal tecleada', '')).toMatch(/6 números/);
    expect(cashVoidProblem('mal tecleada', '12345')).toMatch(/6 números/);
    expect(cashVoidProblem('mal tecleada', '123456')).toBeNull();
  });

  it('lo que sale de la caja y lo que le queda al saldo', () => {
    expect(cashVoidDoneText({ amountCents: 5_000, balanceCents: 1_000 })).toMatch(
      /^Anulada: 50,00\s€ salen de la caja\. Al saldo le quedan 10,00\s€\.$/,
    );
  });
});

describe('anular una recarga con la «Comisión del servicio»: sale de la caja el saldo + ella', () => {
  const sp = (s: string) => s.replace(/\s/g, ' ');
  it('lo que sale, con su desglose; sin comisión, como siempre', () => {
    expect(sp(cashVoidOutText({ amountCents: 10_000, serviceFeeCents: 1_200 }))).toBe('112,00 € (100,00 € de saldo + 12,00 € de comisión del servicio)');
    expect(sp(cashVoidOutText({ amountCents: 10_000, serviceFeeCents: 0 }))).toBe('100,00 €');
    expect(sp(cashVoidOutText({ amountCents: 10_000 }))).toBe('100,00 €');
    expect(sp(cashVoidDoneText({ amountCents: 10_000, serviceFeeCents: 1_200, balanceCents: 0 }))).toBe(
      'Anulada: 112,00 € (100,00 € de saldo + 12,00 € de comisión del servicio) salen de la caja. Al saldo le quedan 0,00 €.',
    );
  });

  it('se manda la comisión que se enseñó (el API no anula sin ella); un API de antes no la da y no se manda', () => {
    expect(cashVoidBody({ amountCents: 10_000, serviceFeeCents: 1_200 }, ' mal ', '123456')).toEqual({ reason: 'mal', totpCode: '123456', serviceFeeCents: 1_200 });
    expect(cashVoidBody({ amountCents: 10_000, serviceFeeCents: 0 }, 'mal', '123456')).toEqual({ reason: 'mal', totpCode: '123456', serviceFeeCents: 0 });
    expect(cashVoidBody({ amountCents: 10_000 }, 'mal', '123456')).toEqual({ reason: 'mal', totpCode: '123456' });
  });
});
