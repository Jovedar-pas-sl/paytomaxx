import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cobraElEncargado, offeredCodes } from '../components/cobrar/cobrar-context';
import { MiQr } from '../components/cobrar/MiQr';
import { SinCobrar } from '../components/cobrar/SinCobrar';
import { EarningsDetail } from '../components/EarningsDetail';
import { mySectionsOf, type MyEarning, type MyNight, type OperatorUser } from './api';
import { whoLine } from './cobro-view';
import { moneySummary } from './earnings-view';
import { FALLBACK_SECTIONS } from './sections';
import { TOURS } from './tours';

// Cobro por el encargado, en la app de la compañera con la casilla apagada:
// «Hoy cobra el encargado» en lugar de la carta, «Mi QR» para el servicio y
// «No es mío» en Ganancias. Se pintan con react-dom/server: solo el marcado.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Intl separa la cifra del «€» (y del «%») con un espacio que no se parte.
const nb = (text: string) => text.replace(/[\u00a0\u202f](€|%)/g, ' $1');
const noop = () => undefined;

const NIGHT: MyNight = {
  from: '2026-11-25T21:00:00.000Z',
  to: null,
  nightOpen: true,
  count: 0,
  chargedCents: 0,
  commissionCents: 5_400,
  tipsCents: 0,
  reversedCents: 0,
  netCents: 5_400,
};

const user = (role: OperatorUser['role']): OperatorUser => ({ id: 'u1', email: 'a@b.c', role, tenantId: 't', venueSlug: 'v', displayName: 'Nerea' });

describe('las secciones que se le ofrecen', () => {
  const all = FALLBACK_SECTIONS.filter((s) => s.enabled).map((s) => s.code);

  it('si se sabe su lista y está vacía, ninguna; si no se sabe, todas', () => {
    expect(offeredCodes({ sections: FALLBACK_SECTIONS, allowed: [] })).toEqual([]);
    expect(offeredCodes({ sections: FALLBACK_SECTIONS, allowed: null })).toEqual(all);
    expect(offeredCodes({ sections: FALLBACK_SECTIONS, allowed: ['CHICA_SERVICE'] })).toEqual(['CHICA_SERVICE']);
  });

  it('«Hoy cobra el encargado» solo para la compañera con la casilla apagada', () => {
    expect(cobraElEncargado({ user: user('OPERATOR'), fromPhone: false })).toBe(true);
    // Sala sin secciones con la casilla encendida: nadie le cobra a su nombre, así que no se le promete.
    expect(cobraElEncargado({ user: user('OPERATOR'), fromPhone: true })).toBe(false);
    // Sin el dato (un API de antes), como hoy.
    expect(cobraElEncargado({ user: user('OPERATOR'), fromPhone: null })).toBe(false);
    expect(cobraElEncargado({ user: user('OPERATOR') })).toBe(false);
    expect(cobraElEncargado({ user: user('WAITER'), fromPhone: false })).toBe(false);
  });

  it('/venues/me → la casilla (myRights.fromPhone); sin el campo, null', () => {
    expect(mySectionsOf({ myRights: { sections: [], fromPhone: false } })).toMatchObject({ allowed: [], fromPhone: false });
    expect(mySectionsOf({ myRights: { sections: [], fromPhone: true } })).toMatchObject({ allowed: [], fromPhone: true });
    expect(mySectionsOf({ myRights: { sections: [] } })).toMatchObject({ allowed: [], fromPhone: null });
    expect(mySectionsOf({})).toMatchObject({ allowed: null, fromPhone: null });
  });

  it('CobrarFlow pinta SinCobrar en lugar de la carta, con el menú y «Mi QR» para el servicio', () => {
    const flow = read('../components/cobrar/CobrarFlow.tsx');
    expect(flow).toContain('cobraElEncargado(ctx)');
    expect(flow).toMatch(/<SinCobrar[\s\S]*?onMiQr=/);
    expect(flow).toMatch(/<MiQr[^>]*forService=/);
  });

  it('en «Hoy cobra el encargado» el menú no ofrece «Practicar» (no hay nada que ensayar); «Salir de práctica», sí', () => {
    const flow = read('../components/cobrar/CobrarFlow.tsx');
    expect(flow).toContain('<PracticeMenuItem onClose={() => setMenu(false)} canStart={!sinCarta} />');
    expect(read('../components/staff-menu.tsx')).toContain('canStart={canStart && !charges.open}');
  });
});

describe('«Hoy cobra el encargado»', () => {
  const pantalla = (night: MyNight | null) =>
    nb(renderToStaticMarkup(<SinCobrar who={whoLine('Nerea', 'OPERATOR')} night={night} banner={<p>Tus reservas de RRPP</p>} onLogo={noop} onMiQr={noop} />));

  it('el título, qué hacer, «Mi QR», lo que lleva esta noche y la tarjeta de RRPP', () => {
    const html = pantalla(NIGHT);
    expect(html).toContain('Hoy cobra el encargado');
    expect(html).toContain('Nerea · compañera');
    expect(html.toLowerCase()).not.toContain('chica');
    expect(html).toContain('aria-label="Menú"');
    expect(html).toContain('Tus reservas de RRPP');
    expect(html).toContain('Tus servicios los cobra el encargado (o recepción) escaneando tu «Mi QR». Lo tuyo te llega al momento a Ganancias.');
    expect(html).toMatch(/<button[^>]*>[\s\S]*?Mi QR<\/button>/);
    expect(html).toMatch(/Esta noche llevas <b[^>]*>54 €<\/b>/);
  });

  it('sin su noche, una raya', () => {
    expect(pantalla(null)).toMatch(/Esta noche llevas <b[^>]*>—<\/b>/);
  });
});

describe('«Mi QR» para el servicio', () => {
  it('con forService, para que le cobren el servicio o la inviten', () => {
    const html = renderToStaticMarkup(<MiQr name="Nerea" invitations={null} onClose={noop} forService />);
    expect(html).toContain('Para que te cobren el servicio o te inviten');
    expect(html).toContain('Enséñaselo al encargado cuando te cobre un servicio, o al camarero cuando te inviten.');
  });

  it('con forService, su propio tutorial: lo escanea el encargado para cobrarle el servicio (y sale una vez aparte)', () => {
    expect(TOURS.miQrServicio.steps[0]!.text).toMatch(/^El encargado lo escanea para cobrarte el servicio; el camarero, cuando te invitan/);
    expect(TOURS.miQrServicio.screen).not.toBe(TOURS.miQr.screen);
    expect(read('../components/cobrar/MiQr.tsx')).toContain('<ScreenHelp {...(forService ? TOURS.miQrServicio : TOURS.miQr)} />');
  });

  it('sin la prop, como hoy', () => {
    const html = renderToStaticMarkup(<MiQr name="Nerea" invitations={null} onClose={noop} />);
    expect(html).toContain('Para que te inviten');
    expect(html).toContain('Enséñaselo al camarero cuando te inviten.');
    expect(html).not.toContain('servicio');
  });
});

describe('Ganancias: «No es mío»', () => {
  const served = (over: Partial<MyEarning> = {}): MyEarning => ({
    id: 'e-1',
    paymentId: 'p-1',
    paymentAmountCents: 12_000,
    commissionBps: 4_500,
    commissionCents: 5_400,
    tipCents: 0,
    reversedCents: 0,
    netCents: 5_400,
    payoutId: null,
    paymentStatus: 'AUTHORIZED',
    createdAt: '2026-11-25T22:30:00.000Z',
    servedByName: 'Carlos',
    notMineReported: false,
    ...over,
  });
  const own: MyEarning = { ...served({ id: 'e-2' }), servedByName: undefined, notMineReported: undefined };
  const tonight = (earnings: MyEarning[]) =>
    nb(
      renderToStaticMarkup(
        <EarningsDetail kind="tonight" night={NIGHT} summary={moneySummary(NIGHT, null)} earnings={earnings} info={null} holdDays={0} onBack={noop} />,
      ),
    );

  it('su fila dice quién se lo cobró y lleva «No es mío»; lo suyo, no', () => {
    const html = tonight([served(), own]);
    expect(html).toContain('Te lo cobró Carlos · 45 % de 120 €');
    expect(html.match(/No es mío/g)).toHaveLength(1);
  });

  it('ya avisado: «Avisado», sin el botón', () => {
    const html = tonight([served({ notMineReported: true })]);
    expect(html).toContain('Avisado');
    expect(html).not.toContain('No es mío');
  });
});
