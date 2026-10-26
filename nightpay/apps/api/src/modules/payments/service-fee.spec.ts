import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVICE_FEE_BPS,
  MAX_SERVICE_FEE_BPS,
  SERVICE_FEE_LABEL,
  SERVICE_FEE_OFF,
  ServiceFeeBpsSchema,
  chargeBreakdownText,
  refundServiceFeePart,
  serviceFeeBpsFor,
  serviceFeeCents,
  serviceFeeOf,
  serviceFeeQuote,
  topUpChargeText,
} from '@nightpay/contracts';

// «Comisión del servicio»: lo que paga el cliente encima del precio (ingreso de OxioPay).

const ON = { enabled: true, cardBps: 1000, topUpBps: 1200 };

describe('serviceFeeCents', () => {
  it('10 % de 33 € son 3,30 €; 12 % de 50 € son 6 €', () => {
    expect(serviceFeeCents(3300, 1000)).toBe(330);
    expect(serviceFeeCents(5000, 1200)).toBe(600);
  });

  it('redondea al céntimo (la mitad hacia arriba) y 0 % es 0', () => {
    expect(serviceFeeCents(1005, 1000)).toBe(101);
    expect(serviceFeeCents(1004, 1000)).toBe(100);
    expect(serviceFeeCents(9999, 0)).toBe(0);
  });

  it('nunca negativa ni con importes o % raros', () => {
    expect(serviceFeeCents(-500, 1000)).toBe(0);
    expect(serviceFeeCents(5000, -10)).toBe(0);
    expect(serviceFeeCents(Number.NaN, 1000)).toBe(0);
  });
});

describe('serviceFeeBpsFor / serviceFeeQuote', () => {
  it('apagado: sin comisión (null) en tarjeta y en recargas', () => {
    expect(serviceFeeBpsFor(SERVICE_FEE_OFF, 'card')).toBeNull();
    expect(serviceFeeBpsFor(SERVICE_FEE_OFF, 'topUp')).toBeNull();
    expect(serviceFeeBpsFor(null, 'card')).toBeNull();
    expect(serviceFeeQuote(SERVICE_FEE_OFF, 'card', 3300)).toEqual({ bps: null, feeCents: 0, totalCents: 3300 });
  });

  it('encendido: el % de cada cosa', () => {
    expect(serviceFeeBpsFor(ON, 'card')).toBe(1000);
    expect(serviceFeeBpsFor(ON, 'topUp')).toBe(1200);
    expect(serviceFeeQuote(ON, 'card', 3300)).toEqual({ bps: 1000, feeCents: 330, totalCents: 3630 });
    expect(serviceFeeQuote(ON, 'topUp', 5000)).toEqual({ bps: 1200, feeCents: 600, totalCents: 5600 });
  });
});

describe('serviceFeeOf (lo que llega del API a las apps)', () => {
  it('lee lo bueno y sin nada (API anterior) es apagado', () => {
    expect(serviceFeeOf({ enabled: true, cardBps: 800, topUpBps: 1200 })).toEqual({ enabled: true, cardBps: 800, topUpBps: 1200 });
    expect(serviceFeeOf(undefined)).toEqual(SERVICE_FEE_OFF);
    expect(serviceFeeOf('x')).toEqual(SERVICE_FEE_OFF);
  });

  it('un % fuera de 0–12 % o no entero no vale: apagado (nunca se cobra de más)', () => {
    expect(serviceFeeOf({ enabled: true, cardBps: 5000, topUpBps: 1000 })).toEqual(SERVICE_FEE_OFF);
    expect(serviceFeeOf({ enabled: true, cardBps: 10.5, topUpBps: 1000 })).toEqual(SERVICE_FEE_OFF);
    expect(serviceFeeOf({ enabled: 'yes', cardBps: 1000, topUpBps: 1000 })).toEqual(SERVICE_FEE_OFF);
  });
});

describe('ServiceFeeBpsSchema', () => {
  it('de 0 a 12 % (1200 bps), entero', () => {
    expect(ServiceFeeBpsSchema.safeParse(0).success).toBe(true);
    expect(ServiceFeeBpsSchema.safeParse(MAX_SERVICE_FEE_BPS).success).toBe(true);
    expect(ServiceFeeBpsSchema.safeParse(1201).success).toBe(false);
    expect(ServiceFeeBpsSchema.safeParse(-1).success).toBe(false);
    expect(ServiceFeeBpsSchema.safeParse(10.5).success).toBe(false);
    expect(DEFAULT_SERVICE_FEE_BPS).toBe(1000);
  });
});

describe('refundServiceFeePart (lo devuelto de la comisión, en proporción)', () => {
  // 33 € + 3,30 € de comisión + 2 € de propina = 38,30 €.
  const charged = 3830;
  const fee = 330;

  it('devolución total: toda la comisión', () => {
    expect(refundServiceFeePart({ feeCents: fee, chargedCents: charged, refundedAfterCents: charged, feeRefundedBeforeCents: 0 })).toBe(330);
  });

  it('en dos partes suman la comisión entera, sin céntimos sueltos', () => {
    const first = refundServiceFeePart({ feeCents: fee, chargedCents: charged, refundedAfterCents: 1100, feeRefundedBeforeCents: 0 });
    expect(first).toBe(95); // 330 × 1100 / 3830 = 94,8
    const second = refundServiceFeePart({ feeCents: fee, chargedCents: charged, refundedAfterCents: charged, feeRefundedBeforeCents: first });
    expect(first + second).toBe(330);
  });

  it('sin comisión o sin nada cobrado: 0; nunca más que lo que queda', () => {
    expect(refundServiceFeePart({ feeCents: 0, chargedCents: charged, refundedAfterCents: 1000, feeRefundedBeforeCents: 0 })).toBe(0);
    expect(refundServiceFeePart({ feeCents: fee, chargedCents: 0, refundedAfterCents: 0, feeRefundedBeforeCents: 0 })).toBe(0);
    expect(refundServiceFeePart({ feeCents: fee, chargedCents: charged, refundedAfterCents: 99_999, feeRefundedBeforeCents: 300 })).toBe(30);
    expect(refundServiceFeePart({ feeCents: fee, chargedCents: charged, refundedAfterCents: 100, feeRefundedBeforeCents: 330 })).toBe(0);
  });
});

/** Intl separa la cifra y el € con un espacio duro (U+00A0). */
const sp = (s: string): string => s.replace(/\u00a0/g, ' ');

describe('textos', () => {
  it('se llama «Comisión del servicio»', () => {
    expect(SERVICE_FEE_LABEL).toBe('Comisión del servicio');
  });

  it('«33 € + 3,30 € comisión del servicio + 2 € propina»', () => {
    const text = (baseCents: number, feeCents: number, tipCents: number) => sp(chargeBreakdownText({ baseCents, feeCents, tipCents }));
    expect(text(3300, 330, 200)).toBe('33 € + 3,30 € comisión del servicio + 2 € propina');
    expect(text(3300, 330, 0)).toBe('33 € + 3,30 € comisión del servicio');
    expect(text(3300, 0, 200)).toBe('33 € + 2 € propina');
    expect(text(3300, 0, 0)).toBe('33 €');
  });

  it('recepción: «Cobra 56 € (50 € de saldo + 6 € de comisión del servicio)»', () => {
    expect(sp(topUpChargeText(5000, 600))).toBe('Cobra 56 € (50 € de saldo + 6 € de comisión del servicio)');
    expect(sp(topUpChargeText(5000, 0))).toBe('Cobra 50 €');
  });
});

describe('lo devuelto de un cobro en el historial del personal', () => {
  const pay = (availableAmountCents: number) => ({ availableAmountCents }) as never;
  it('un pago directo devuelve también su comisión; una recarga, no', async () => {
    const { ownRefundedCents } = await import('@nightpay/contracts');
    // 33 + 3,30 + 2 = 38,30 €, quedan 19,15 € por devolver → devueltos 19,15 €.
    expect(ownRefundedCents({ status: 'PARTIALLY_REFUNDED', amountCents: 3300, tipCents: 200, serviceFeeCents: 330, payment: pay(1915) })).toBe(1915);
    // Recarga de 50 € (+6 € de comisión, no devolvible): quedan 30 € → devueltos 20 €.
    expect(ownRefundedCents({ status: 'PARTIALLY_REFUNDED', amountCents: 5000, tipCents: 0, serviceFeeCents: 600, isTopUp: true, payment: pay(3000) })).toBe(2000);
    // Sin comisión, como siempre.
    expect(ownRefundedCents({ status: 'REFUNDED', amountCents: 3300, tipCents: 200, payment: pay(0) })).toBe(3500);
  });
});
