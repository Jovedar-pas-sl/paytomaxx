import { describe, expect, it } from 'vitest';
import { unpaidLine, unpaidState, unpaidToShow, type UnpaidCobro } from './api-sin-pagar';

const u = (o: Partial<UnpaidCobro> = {}): UnpaidCobro => ({
  id: 'p1',
  ref: 'C-0012',
  totalCents: 1200,
  status: 'AWAITING_CAPTURE',
  createdAt: '2026-11-16T22:40:00.000Z',
  createdByName: 'Lucía',
  mine: false,
  atBank: false,
  bitcoin: false,
  ...o,
});

describe('«Sin pagar en el local»', () => {
  it('se reconoce: referencia, importe y de quién', () => {
    expect(unpaidLine(u())).toMatch(/^C-0012 · 12\s?€ · de Lucía$/);
    expect(unpaidLine(u({ mine: true, ref: null }))).toMatch(/^12\s?€ · tuyo$/);
  });

  it('dice si el cliente está en su banco (los 2 primeros minutos y después) o pagando con bitcoin', () => {
    expect(unpaidState(u({ status: 'AUTHORIZING', atBank: true }), 'wait')).toBe('El cliente está pagando en su banco');
    expect(unpaidState(u({ status: 'AUTHORIZING', atBank: true }), 'late')).toBe('El banco tarda. Si el cliente no ha pagado, puedes cancelar');
    expect(unpaidState(u({ status: 'AUTHORIZING', bitcoin: true }))).toBe('Pagando con bitcoin');
    expect(unpaidState(u())).toBe('Esperando el pago');
  });

  it('la chica ya cancela los suyos en su lista: aquí, solo los de otras personas; el resto los ve todos', () => {
    const items = [u({ id: 'a', mine: true }), u({ id: 'b' })];
    expect(unpaidToShow(items, true).map((x) => x.id)).toEqual(['b']);
    expect(unpaidToShow(items, false).map((x) => x.id)).toEqual(['a', 'b']);
  });
});
