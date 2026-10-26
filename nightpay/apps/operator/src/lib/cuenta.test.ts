import { describe, expect, it } from 'vitest';
import {
  EMPTY_CUENTA,
  PROPINAS,
  addAmount,
  addItem,
  chargeLinesOf,
  chargeable,
  cobrarYApuntar,
  otroPlan,
  type Cuenta,
  cuentaSummary,
  cuentaTotals,
  cuentaWhat,
  itemLabel,
  qtyOf,
  removeLine,
  setQty,
  type CartaItem,
} from './cuenta';

const COPA: CartaItem = { id: 'c-copa', name: 'Copa', priceCents: 1000, category: 'VENUE_BAR' };
const TABLA: CartaItem = { id: 'c-tabla', name: 'Tabla ibérica', priceCents: 3000, category: 'VENUE_FOOD' };
const HORA: CartaItem = { id: 'c-1h', name: '1 h', priceCents: 12_000, category: 'CHICA_SERVICE' };
const PACK: CartaItem = {
  id: 'c-pack',
  name: '1 h con habitación',
  priceCents: 15_000,
  category: 'CHICA_SERVICE',
  components: [
    { category: 'CHICA_SERVICE', amountCents: 12_000 },
    { category: 'VENUE_ROOM', amountCents: 3000 },
  ],
};
const label = (s: string) => ({ VENUE_BAR: 'Copas', VENUE_FOOD: 'Comida', CHICA_SERVICE: 'Servicios' })[s] ?? s;

describe('la cuenta de «Cobrar»', () => {
  it('2 copas y una tabla: ×2 en la copa, 50 € en dos secciones, sin tocar la cuenta de antes', () => {
    const one = addItem(EMPTY_CUENTA, COPA);
    const two = addItem(one, COPA);
    const cuenta = addItem(two, TABLA);
    expect(one).toHaveLength(1);
    expect(qtyOf(one, COPA.id)).toBe(1);
    expect(qtyOf(cuenta, COPA.id)).toBe(2);
    expect(cuentaTotals(cuenta)).toEqual({
      amountCents: 5000,
      tipCents: 0,
      totalCents: 5000,
      bySection: [
        { section: 'VENUE_BAR', cents: 2000 },
        { section: 'VENUE_FOOD', cents: 3000 },
      ],
    });
    expect(chargeLinesOf(cuenta)).toEqual([
      { serviceItemId: COPA.id, qty: 2 },
      { serviceItemId: TABLA.id, qty: 1 },
    ]);
    expect(cuentaSummary(cuenta, label)).toBe('2× Copa + Tabla ibérica');
  });

  it('una sola cosa: «1 h · Servicios»; con varias, «2× …»', () => {
    expect(cuentaSummary(addItem(EMPTY_CUENTA, HORA), label)).toBe('1 h · Servicios');
    expect(cuentaSummary(addItem(addItem(EMPTY_CUENTA, COPA), COPA), label)).toBe('2× Copa · Copas');
    expect(cuentaSummary(EMPTY_CUENTA, label)).toBe('');
  });

  it('los pasos de la cuenta: más, menos y a 0 se quita', () => {
    const cuenta = addItem(addItem(EMPTY_CUENTA, COPA), TABLA);
    const key = cuenta[0]!.key;
    expect(qtyOf(setQty(cuenta, key, 3), COPA.id)).toBe(3);
    expect(setQty(cuenta, key, 0)).toHaveLength(1);
    expect(qtyOf(setQty(cuenta, key, 500), COPA.id)).toBe(50);
    expect(removeLine(cuenta, cuenta[1]!.key)).toHaveLength(1);
  });

  it('«Otro importe» en su sección y la propina aparte (no es una línea del cobro)', () => {
    const cuenta = addAmount(addAmount(addItem(EMPTY_CUENTA, COPA), 'VENUE_BAR', 3500), PROPINAS, 500);
    expect(cuentaTotals(cuenta)).toMatchObject({ amountCents: 4500, tipCents: 500, totalCents: 5000 });
    expect(cuentaTotals(cuenta).bySection).toEqual([
      { section: 'VENUE_BAR', cents: 4500 },
      { section: 'propinas', cents: 500 },
    ]);
    expect(chargeLinesOf(cuenta)).toEqual([
      { serviceItemId: COPA.id, qty: 1 },
      { category: 'VENUE_BAR', amountCents: 3500, label: 'Otro importe' },
    ]);
    expect(addAmount(EMPTY_CUENTA, 'VENUE_BAR', 0)).toBe(EMPTY_CUENTA);
    expect(cuentaSummary(cuenta, label)).toBe('Copa + otro importe + propina');
  });

  it('una propina sola no se cobra: hace falta algo que vender', () => {
    expect(chargeable(addAmount(EMPTY_CUENTA, PROPINAS, 500))).toBe(false);
    expect(chargeable(addItem(EMPTY_CUENTA, COPA))).toBe(true);
    expect(chargeable(EMPTY_CUENTA)).toBe(false);
  });

  it('un pack reparte en sus secciones', () => {
    expect(cuentaTotals(addItem(EMPTY_CUENTA, PACK)).bySection).toEqual([
      { section: 'CHICA_SERVICE', cents: 12_000 },
      { section: 'VENUE_ROOM', cents: 3000 },
    ]);
  });

  it('muchas cosas: las dos primeras y «+ N más»', () => {
    let cuenta = EMPTY_CUENTA;
    for (const item of [COPA, TABLA, HORA, PACK]) cuenta = addItem(cuenta, item);
    expect(cuentaSummary(cuenta, label)).toBe('Copa + Tabla ibérica + 2 más');
  });

  it('nombres con su duración', () => {
    expect(itemLabel({ name: 'Masaje', durationMin: 30 })).toBe('Masaje · 30 min');
    expect(itemLabel({ name: '30 min', durationMin: 30 })).toBe('30 min');
  });

  it('lo que se cobra, corto (la banda y el PAGADO): sin la propina', () => {
    expect(cuentaWhat(addItem(addItem(EMPTY_CUENTA, COPA), COPA))).toBe('2× Copa');
    expect(cuentaWhat(addItem(EMPTY_CUENTA, HORA))).toBe('1 h');
    expect(cuentaWhat(addAmount(addItem(addItem(EMPTY_CUENTA, COPA), TABLA), PROPINAS, 500))).toBe('Copa + Tabla ibérica');
    let many = EMPTY_CUENTA;
    for (const item of [COPA, TABLA, HORA, PACK]) many = addItem(many, item);
    expect(cuentaWhat(many)).toBe('Copa + Tabla ibérica + 2 más');
    expect(cuentaWhat(addAmount(EMPTY_CUENTA, 'VENUE_BAR', 3500))).toBe('otro importe');
  });
});

describe('los resúmenes dicen el nombre de la carta tal cual (nada de plurales inventados)', () => {
  const GIN: CartaItem = { id: 'c-gin', name: 'Gin tonic', priceCents: 1200, category: 'VENUE_BAR' };
  const NACHOS: CartaItem = { id: 'c-nachos', name: 'Nachos', priceCents: 900, category: 'VENUE_FOOD' };
  const ENTRADA: CartaItem = { id: 'c-entrada', name: 'Entrada', priceCents: 1500, category: 'VENUE_ENTRY' };
  const ENTRADA_VIP: CartaItem = { id: 'c-entrada-vip', name: 'Entrada VIP', priceCents: 3000, category: 'VENUE_ENTRY' };
  const add = (...items: CartaItem[]) => items.reduce((c, i) => addItem(c, i), EMPTY_CUENTA);

  it('2 gin tonic y unos nachos: «2× Gin tonic + Nachos» (no «2 gines + nachos»)', () => {
    const cuenta = add(GIN, GIN, NACHOS);
    expect(cuentaSummary(cuenta, label)).toBe('2× Gin tonic + Nachos');
    expect(cuentaWhat(cuenta)).toBe('2× Gin tonic + Nachos');
  });

  it('un nombre que ya acaba en s, de varias palabras o que es un número sale igual', () => {
    expect(cuentaWhat(add(NACHOS, NACHOS))).toBe('2× Nachos');
    expect(cuentaSummary(add(HORA, HORA, COPA), label)).toBe('2× 1 h + Copa');
    expect(cuentaSummary(add(ENTRADA, ENTRADA, ENTRADA_VIP), label)).toBe('2× Entrada + Entrada VIP');
    for (const name of ['Red Bull', 'Champán', 'Patatas bravas', 'Menú del día', 'Kebab']) {
      const item: CartaItem = { id: `x-${name}`, name, priceCents: 1000, category: 'VENUE_BAR' };
      expect(cuentaWhat(add(item, item))).toBe(`2× ${name}`);
      expect(cuentaSummary(add(item, item, COPA), label)).toBe(`2× ${name} + Copa`);
    }
  });

  it('el dinero no cambia: los totales y las líneas que van al API son los mismos', () => {
    const cuenta = add(GIN, GIN, NACHOS);
    expect(cuentaTotals(cuenta)).toEqual({
      amountCents: 3300,
      tipCents: 0,
      totalCents: 3300,
      bySection: [
        { section: 'VENUE_BAR', cents: 2400 },
        { section: 'VENUE_FOOD', cents: 900 },
      ],
    });
    expect(chargeLinesOf(cuenta)).toEqual([
      { serviceItemId: GIN.id, qty: 2 },
      { serviceItemId: NACHOS.id, qty: 1 },
    ]);
  });
});

describe('«Otro importe» con la cuenta vacía (APP-01)', () => {
  it('con la cuenta vacía se cobra ya; con algo en la cuenta, o una propina, se suma', () => {
    expect(otroPlan(EMPTY_CUENTA, 'VENUE_BAR', 2000).kind).toBe('cobrar');
    expect(otroPlan(EMPTY_CUENTA, PROPINAS, 200).kind).toBe('sumar');
    expect(otroPlan(addItem(EMPTY_CUENTA, COPA), 'VENUE_BAR', 2000).kind).toBe('sumar');
    expect(cuentaTotals(otroPlan(EMPTY_CUENTA, 'VENUE_BAR', 2000).next).totalCents).toBe(2000);
  });

  it('el cobro no se abre (sin red): la cuenta sigue vacía y el segundo toque cobra 20 €, no 40 €', async () => {
    let cuenta: Cuenta = EMPTY_CUENTA;
    const asked: number[] = [];
    const open = async (c: Cuenta): Promise<boolean> => {
      asked.push(cuentaTotals(c).totalCents);
      return asked.length > 1;
    };
    const apuntar = (c: Cuenta): void => {
      cuenta = c;
    };
    expect(await cobrarYApuntar(otroPlan(cuenta, 'VENUE_BAR', 2000).next, open, apuntar)).toBe(false);
    expect(cuenta).toEqual(EMPTY_CUENTA);
    // Otra vez «Cobrar 20 €»: la cuenta seguía vacía, así que se cobra lo mismo.
    const again = otroPlan(cuenta, 'VENUE_BAR', 2000);
    expect(again.kind).toBe('cobrar');
    expect(await cobrarYApuntar(again.next, open, apuntar)).toBe(true);
    expect(asked).toEqual([2000, 2000]);
    expect(cuentaTotals(cuenta).totalCents).toBe(2000);
  });

  it('si la apertura revienta, la cuenta tampoco se toca', async () => {
    let touched = false;
    await expect(
      cobrarYApuntar(
        otroPlan(EMPTY_CUENTA, 'VENUE_BAR', 2000).next,
        () => Promise.reject(new Error('sin red')),
        () => {
          touched = true;
        },
      ),
    ).rejects.toThrow('sin red');
    expect(touched).toBe(false);
  });
});
