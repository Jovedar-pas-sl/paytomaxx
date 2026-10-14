import { describe, expect, it } from 'vitest';
import { operatorAppBaseUrl } from './operator-app-url';

describe('dirección de la app de las chicas (enlace de invitación)', () => {
  it('sin OPERATOR_BASE_URL en producción: la del API con "operator."', () => {
    expect(operatorAppBaseUrl({ apiUrl: 'https://api.paytomaxx.com/', production: true })).toBe('https://operator.paytomaxx.com');
  });

  it('OPERATOR_BASE_URL o NEXT_PUBLIC_OPERATOR_URL mandan', () => {
    expect(
      operatorAppBaseUrl({ operatorBaseUrl: 'https://chicas.oxiopay.es/', apiUrl: 'https://api.paytomaxx.com', production: true }),
    ).toBe('https://chicas.oxiopay.es');
    expect(
      operatorAppBaseUrl({ operatorUrl: 'https://op.oxiopay.es', apiUrl: 'https://api.paytomaxx.com', production: true }),
    ).toBe('https://op.oxiopay.es');
  });

  it('sin forma de saberlo: null en producción (se avisa antes de crear nada); localhost en local', () => {
    expect(operatorAppBaseUrl({ apiUrl: 'https://pagos.oxiopay.es', production: true })).toBeNull();
    expect(operatorAppBaseUrl({ operatorBaseUrl: '  ', production: true })).toBeNull();
    expect(operatorAppBaseUrl({ apiUrl: 'http://localhost:4100', production: false })).toBe('http://localhost:4104');
  });
});
