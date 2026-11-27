import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CARD_GATEWAY_LABELS, cobroBody } from './api-cobro';
import { GatewayButtons } from '../components/cobrar/LaCuenta';

// Yavin (decisión del dueño): en un local con BBVA y Yavin, el camarero elige
// en cada cobro con tarjeta. Con una sola pasarela no se ve elección.
describe('elección «BBVA» / «Yavin» al cobrar', () => {
  it('el cobro lleva la pasarela elegida; sin elegir, nada (decide el servidor, como hoy)', () => {
    expect(cobroBody({ lines: [], cardGateway: 'YAVIN' }).cardGateway).toBe('YAVIN');
    expect(cobroBody({ lines: [], cardGateway: 'REDSYS' }).cardGateway).toBe('REDSYS');
    expect('cardGateway' in cobroBody({ lines: [] })).toBe(false);
    // Con datáfono no hay pasarela que elegir.
    expect('cardGateway' in cobroBody({ lines: [], pos: true, cardGateway: 'YAVIN' })).toBe(false);
  });

  it('los dos botones se llaman «BBVA» y «Yavin»', () => {
    expect(CARD_GATEWAY_LABELS).toEqual({ REDSYS: 'BBVA', YAVIN: 'Yavin' });
    const html = renderToStaticMarkup(<GatewayButtons gateways={['REDSYS', 'YAVIN']} onGateway={() => undefined} disabled={false} busy={false} />);
    expect(html).toContain('>BBVA</button>');
    expect(html).toContain('>Yavin</button>');
    expect(html.match(/<button/g)).toHaveLength(2);
  });
});
