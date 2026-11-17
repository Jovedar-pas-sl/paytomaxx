import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  bpsToPercent,
  currentNight,
  emptyPackageForm,
  eurosToCents,
  packageFormToInput,
  packageSummary,
  packageToForm,
  parseItems,
  percentToBps,
  reservationActions,
  statusTone,
  venueCancelText,
  venueCanceledNotice,
} from './reservations';

describe('el % de los RRPP', () => {
  it('cada uno el suyo, de 0 % a 50 %', () => {
    expect(percentToBps('10')).toBe(1000);
    expect(percentToBps('12,5 %')).toBe(1250);
    expect(percentToBps('51')).toBeNull();
    expect(percentToBps('x')).toBeNull();
    expect(bpsToPercent(1250)).toBe('12,5');
  });
});

describe('importes y cosas del paquete', () => {
  it('euros escritos a mano → céntimos enteros', () => {
    expect(eurosToCents('300')).toBe(30000);
    expect(eurosToCents('300,50')).toBe(30050);
    expect(eurosToCents(' 12.5 € ')).toBe(1250);
    expect(eurosToCents('abc')).toBeNull();
    expect(eurosToCents('1,234')).toBeNull();
  });

  it('una cosa por línea, con o sin número', () => {
    expect(parseItems('2 Botella premium\n6 x Entrada\nMesa VIP')).toEqual([
      { name: 'Botella premium', qty: 2 },
      { name: 'Entrada', qty: 6 },
      { name: 'Mesa VIP', qty: 1 },
    ]);
    expect(parseItems('')).toEqual([]);
  });

  it('lo que incluye en una línea', () => {
    expect(packageSummary({ kind: 'ITEMS', entries: 6, creditCents: 0, items: [{ name: 'Botella', qty: 2 }] })).toBe('6 personas · 2 × Botella');
    expect(packageSummary({ kind: 'CREDIT', entries: 1, creditCents: 40000, items: [] }).replace(/\u00a0/g, ' ')).toBe('1 persona · 400,00 € para consumir');
  });
});

describe('el formulario del paquete', () => {
  it('de cosas fijas: precio, personas y al menos una cosa', () => {
    const f = { ...emptyPackageForm(), name: 'Mesa', price: '300', items: '2 Botella' };
    expect(packageFormToInput(f)).toEqual({
      ok: true,
      input: { name: 'Mesa', kind: 'ITEMS', priceCents: 30000, creditCents: 0, entries: 6, items: [{ name: 'Botella', qty: 2 }], description: null, maxPerNight: null },
    });
    expect(packageFormToInput({ ...f, items: '' })).toEqual({ ok: false, error: 'Pon al menos una cosa del paquete' });
    expect(packageFormToInput({ ...f, price: '5' })).toEqual({ ok: false, error: 'El precio va de 10 € a 10.000 €' });
  });

  it('de importe: lo que hay para consumir, hasta el precio', () => {
    const f = { ...emptyPackageForm(), name: 'Consumo', kind: 'CREDIT' as const, price: '500', credit: '400', items: '2 Botella' };
    const out = packageFormToInput(f);
    expect(out.ok && out.input).toMatchObject({ creditCents: 40000, items: [] });
    expect(packageFormToInput({ ...f, credit: '600' })).toEqual({ ok: false, error: 'El importe para consumir va de 1 € al precio del paquete' });
  });

  it('ida y vuelta desde un paquete guardado', () => {
    const form = packageToForm({
      id: 'p', name: 'Mesa', kind: 'ITEMS', priceCents: 30050, creditCents: 0, depositCents: 9015, entries: 4,
      items: [{ name: 'Botella', qty: 2 }], description: null, maxPerNight: 3, active: true,
    });
    expect(form).toMatchObject({ price: '300,50', items: '2 Botella', maxPerNight: '3' });
  });
});

describe('la noche y los botones', () => {
  it('antes de las 08:00 de Madrid aún es la noche de ayer', () => {
    expect(currentNight(new Date('2026-11-21T06:30:00Z'))).toBe('2026-11-20');
    expect(currentNight(new Date('2026-11-21T07:30:00Z'))).toBe('2026-11-21');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });

  it('«Cancelar» solo lo que no está pagado; pagada, «Anular» (ya no «Devolver»)', () => {
    expect(reservationActions({ status: 'PENDING', paidCents: 0 }).cancel).toBe('Cancelar');
    expect(reservationActions({ status: 'DEPOSIT_PAID', paidCents: 9000 }).cancel).toBe('Anular');
    expect(reservationActions({ status: 'PAID', paidCents: 30000 }).cancel).toBe('Anular');
    expect(reservationActions({ status: 'ARRIVED', paidCents: 30000 })).toEqual({ table: true, changeDate: false, cancel: null });
    expect(reservationActions({ status: 'NO_SHOW', paidCents: 9000 })).toEqual({ table: false, changeDate: false, cancel: null });
    expect(reservationActions({ status: 'CLIENT_CANCELED', paidCents: 30000 }).cancel).toBeNull();
    expect(statusTone('CLIENT_CANCELED')).toBe('bad');
  });
});

describe('el local anula un reservado pagado: lo pagado queda como saldo del cliente (decisión del 17-nov)', () => {
  it('la confirmación dice cuánto queda como saldo; sin pagar, que se anula sin más', () => {
    expect(venueCancelText({ paidCents: 15000 })).toMatch(/^Lo pagado \(150(,00)?\s?€\) queda como saldo del cliente\.$/);
    // Con bitcoin, igual: también queda como saldo (ya no «solo en euros, habla con el dueño»).
    expect(venueCancelText({ paidCents: 28000, paidWithBitcoinCents: 28000 })).toMatch(/^Lo pagado \(280(,00)?\s?€\) queda como saldo del cliente\.$/);
    expect(venueCancelText({ paidCents: 0 })).toBe('Se anula la reserva sin pagar.');
  });

  it('lo que dice el panel después de anular', () => {
    expect(venueCanceledNotice('K7Q4M2', 15000)).toMatch(/^K7Q4M2: anulada\. Lo pagado \(150(,00)?\s?€\) queda como saldo del cliente\.$/);
    expect(venueCanceledNotice('K7Q4M2', 0)).toBe('K7Q4M2: anulada.');
  });

  it('la tarjeta del reservado ya no habla de devolver ni manda a «Devolver saldo»', () => {
    const card = readFileSync(new URL('../components/reservations/ReservationCard.tsx', import.meta.url), 'utf8');
    expect(card).not.toMatch(/Devolver|y devuelve|se devuelve desde|bitcoinRefundNote|refundCents/);
    expect(card).toContain('Nada se devuelve');
    expect(card).toContain('venueCancelText(r)');
    expect(card).toContain('venueCanceledNotice(r.ref, out.saldoCents)');
  });
});

describe('Reservados en el móvil: los campos no hacen zoom ni se salen en el iPhone', () => {
  it('los campos de las cinco pantallas: letra de 16 px, 44 px de alto y sin ancho mínimo', () => {
    for (const file of ['NightList', 'PackagesEditor', 'PromotersCard', 'ReservationCard', 'ReservationsLinkCard']) {
      const src = readFileSync(new URL(`../components/reservations/${file}.tsx`, import.meta.url), 'utf8');
      const style = src.match(/const input: CSSProperties = \{([^}]*)\};/)?.[1] ?? '';
      expect(style, file).toContain("fontSize: '1rem'");
      expect(style, file).toContain("minHeight: '2.75rem'");
      expect(style, file).toContain('minWidth: 0');
    }
  });
});

describe('Ajustes → Bitcoin: para qué sirve ya no se elige', () => {
  it('sin el selector de antes y con la frase: cargar saldo y reservados, en la barra no', () => {
    const panel = readFileSync(new URL('../components/settings/BtcpayPanel.tsx', import.meta.url), 'utf8');
    expect(panel).not.toContain('Para qué lo usa este local');
    expect(panel).not.toMatch(/purpose/);
    expect(panel).toContain('{BITCOIN_USE_TEXT}');
  });
});
