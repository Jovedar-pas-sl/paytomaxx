import { describe, expect, it } from 'vitest';
import {
  SERVICE_OPERATOR_INVALID_CODE,
  SERVICE_OPERATOR_NOT_NEEDED_CODE,
  SERVICE_OPERATOR_REQUIRED_CODE,
  STAFF_PERMISSION_DENIED_CODE,
} from '@nightpay/contracts';
import { CobroApiError } from './api-cobro';
import { addItem, EMPTY_CUENTA, type CartaItem } from './cuenta';
import { needsCompanera, posWaitTexts, servicioDe } from './servicio';

const HORA: CartaItem = { id: 'c-1h', name: 'Servicio 1 h', priceCents: 6000, category: 'CHICA_SERVICE' };
const COPA: CartaItem = { id: 'c-copa', name: 'Copa', priceCents: 1000, category: 'VENUE_BAR' };
const PACK: CartaItem = {
  id: 'c-pack',
  name: 'Habitación con servicio',
  priceCents: 13_000,
  category: 'VENUE_ROOM',
  components: [
    { category: 'VENUE_ROOM', amountCents: 8000 },
    { category: 'CHICA_SERVICE', amountCents: 5000 },
  ],
};

describe('cobro por el encargado: cuándo pide la compañera el API', () => {
  it('con 400 SERVICE_OPERATOR_REQUIRED o SERVICE_OPERATOR_INVALID: a escanear su «Mi QR»', () => {
    expect(needsCompanera(new CobroApiError(400, 'escanea su «Mi QR»', SERVICE_OPERATOR_REQUIRED_CODE))).toBe(true);
    expect(needsCompanera(new CobroApiError(400, 'ese QR no vale', SERVICE_OPERATOR_INVALID_CODE))).toBe(true);
  });

  it('sin permiso, sin servicio, el servidor caído o un fallo de red: el error tal cual', () => {
    expect(needsCompanera(new CobroApiError(403, 'los cobra el encargado', STAFF_PERMISSION_DENIED_CODE))).toBe(false);
    expect(needsCompanera(new CobroApiError(400, 'no hace falta', SERVICE_OPERATOR_NOT_NEEDED_CODE))).toBe(false);
    expect(needsCompanera(new CobroApiError(500, 'El servidor está teniendo problemas.', null))).toBe(false);
    expect(needsCompanera(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('lo que se le apunta a la compañera (ServicioDe)', () => {
  it('dos «Servicio 1 h» de 60 €: 120 € de Servicios', () => {
    const cuenta = addItem(addItem(EMPTY_CUENTA, HORA), HORA);
    expect(servicioDe(cuenta)).toEqual({ serviceCents: 12_000, totalCents: 12_000 });
  });

  it('el pack Habitación 80 + Servicio 50: solo la parte de Servicios (50 €)', () => {
    const cuenta = addItem(addItem(EMPTY_CUENTA, PACK), COPA);
    expect(servicioDe(cuenta)).toEqual({ serviceCents: 5000, totalCents: 14_000 });
  });

  it('solo copas: nada de Servicios', () => {
    expect(servicioDe(addItem(EMPTY_CUENTA, COPA))).toEqual({ serviceCents: 0, totalCents: 1000 });
  });
});

describe('la espera del datáfono', () => {
  it('si lo cobra el encargado: «POS», sin «camarero»', () => {
    const t = posWaitTexts(true);
    expect(`${t.codeLead} ${t.after}`).toContain('«POS»');
    expect(`${t.codeLead} ${t.after}`.toLowerCase()).not.toContain('camarero');
    expect(t.callWaiter).toBe(false);
  });

  it('la compañera (como hoy): que llame al camarero', () => {
    const t = posWaitTexts(false);
    expect(t.codeLead).toBe('Llama al camarero. Código:');
    expect(t.callWaiter).toBe(true);
  });
});
