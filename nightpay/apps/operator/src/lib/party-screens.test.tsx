import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NIGHT_SETTINGS, DEFAULT_PAYMENT_METHODS } from '@nightpay/contracts';
import { Barra } from '../components/party/Barra';
import { PartyPaidDetail } from '../components/party/PartyPaid';
import { TaquillaForm } from '../components/party/TaquillaForm';
import type { CobrarContext } from '../components/cobrar/cobrar-context';
import { EMPTY_CUENTA, addItem, type CartaItem } from './cuenta';
import { partySections } from './party-barra';
import { pulseraCard } from './party-taquilla';
import { topUpCharge } from './reception';
import { FALLBACK_SECTIONS } from './sections';
import { VenueIdentityContext } from './venue-identity';

// Las pantallas de OxioParty, pintadas sin navegador: lo que se ve con una
// cuenta y una pulsera de ejemplo (las cuentas, en party-barra y party-taquilla).

const nb = (text: string) => text.replace(/ €/g, ' €');

const CANA: CartaItem = { id: 'cana', name: 'Caña', priceCents: 200, category: 'VENUE_BAR' };
const BOCATA: CartaItem = { id: 'bocata', name: 'Bocadillo', priceCents: 450, category: 'VENUE_FOOD' };
const INVITA: CartaItem = { id: 'inv', name: 'Copa con invitación', priceCents: 1000, category: 'VENUE_BAR', isInvitation: true };

const ctx: CobrarContext = {
  user: { id: 'u1', email: 'a@b.c', role: 'WAITER', tenantId: 't', venueSlug: 'v', displayName: 'Carlos' },
  sections: partySections(FALLBACK_SECTIONS),
  allowed: null,
  post: null,
  defaultCategory: null,
  tips: false,
  methods: DEFAULT_PAYMENT_METHODS,
  night: DEFAULT_NIGHT_SETTINGS,
  rules: null,
  carta: [CANA, INVITA, BOCATA],
  cartaLoaded: true,
  cartaFailed: false,
};

const noop = () => undefined;

function barra(cuenta = EMPTY_CUENTA) {
  return renderToStaticMarkup(
    <VenueIdentityContext.Provider value={{ venueName: 'Fallas Ruzafa', stallName: 'Peña El Cántaro' }}>
      <Barra
        ctx={ctx}
        cuenta={cuenta}
        onItem={noop}
        onStep={noop}
        onVaciar={noop}
        onOtro={noop}
        onCobrar={noop}
        busy={false}
        error={null}
        onMenu={noop}
        onRetryCarta={noop}
      />
    </VenueIdentityContext.Provider>,
  );
}

describe('OxioParty · la barra', () => {
  it('la cabecera con la caseta, el local y «En línea»; el filtro «Todo» y sus secciones', () => {
    const html = barra();
    expect(html).toContain('Peña El Cántaro');
    expect(html).toContain('Carlos · Fallas Ruzafa');
    expect(html).toContain('En línea');
    expect(html).toContain('aria-label="Filtrar la carta"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Todo</);
  });

  it('las losetas con su icono y su precio, sin la copa con invitación; «Otro importe» al final', () => {
    const html = barra();
    expect(html).toContain(`aria-label="${nb('Añadir Caña, 2,00 €')}"`);
    expect(html).toContain('data-icon="drink"');
    expect(html).toContain('data-icon="food"');
    expect(html).not.toContain('Copa con invitación');
    expect(html).toContain('Otro importe');
  });

  it('vacío: «Toca lo que pide el cliente» y «Cobrar» apagado', () => {
    const html = barra();
    expect(html).toContain('Toca lo que pide el cliente');
    expect(html).toMatch(/<button type="button"[^>]*disabled=""[^>]*><svg[^>]*>.*?<\/svg><span>Cobrar 0,00/);
  });

  it('con 2 cañas: la burbuja, la línea con − y + y «Cobrar 4,00 €»', () => {
    const html = barra(addItem(addItem(EMPTY_CUENTA, CANA), CANA));
    expect(html).toContain('Ticket · 2 artículos');
    expect(html).toContain('aria-label="Uno menos: Caña"');
    expect(html).toContain('aria-label="Uno más: Caña"');
    expect(html).toContain(nb('Cobrar 4,00 €'));
    expect(html).toContain(`${nb('Añadir Caña, 2,00 €')}. Lleva 2`);
  });
});

describe('OxioParty · la taquilla', () => {
  const view = { kind: 'new' as const, printedNumber: '00000412', fichaNumber: 412 };
  const options = { cash: true, card: true } as Parameters<typeof topUpCharge>[0] & { cash: boolean; card: boolean };

  function taquilla(buttons = [
    { method: 'cash' as const, primary: true, problem: null },
    { method: 'card' as const, primary: false, problem: null },
  ]) {
    return renderToStaticMarkup(
      <TaquillaForm
        card={pulseraCard({ view })}
        recent={null}
        initialAmount={2000}
        buttonsFor={() => buttons}
        chargeFor={(cents) => topUpCharge(options, cents)}
        loading={false}
        pinNote={null}
        busy={false}
        error={null}
        onAnother={noop}
        onOther={noop}
        onSubmit={noop}
      />,
    );
  }

  it('la pulsera nueva, 20 € marcados y efectivo con «Te da» y el cambio', () => {
    const html = taquilla();
    expect(html).toContain('Pulsera 412');
    expect(html).toContain('Nueva');
    expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${nb('20 €')}<`));
    expect(html).toContain('aria-label="Billete recibido"');
    expect(html).toContain('Cambio');
    expect(html).toContain(nb('Cargar 20 € en efectivo'));
  });

  it('con la tarjeta de por defecto: el aviso del QR y «Cobrar 20 € con tarjeta»', () => {
    const html = taquilla([
      { method: 'card', primary: true, problem: null },
      { method: 'cash', primary: false, problem: null },
    ]);
    expect(html).toContain('Saldrá un QR');
    expect(html).toContain(nb('Cobrar 20 € con tarjeta'));
    expect(html).not.toContain('Billete recibido');
  });
});

describe('OxioParty · el PAGADO de la barra', () => {
  it('su detalle y que vuelve sola a la carta', () => {
    const html = renderToStaticMarkup(<PartyPaidDetail rows={[{ label: 'Pulsera', value: '412' }]} onBack={noop} />);
    expect(html).toContain('<dt>Pulsera</dt><dd>412</dd>');
    expect(html).toContain('Vuelve sola a la carta en 3 s');
  });
});
