import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NIGHT_SETTINGS, DEFAULT_PAYMENT_METHODS } from '@nightpay/contracts';
import { servedTipsOn, type CobrarContext } from '../components/cobrar/cobrar-context';
import { mySectionsOf } from './api';
import { rejectedQr, shouldResolveQr } from './qr-scan';
import { ServicioDe } from '../components/cobrar/ServicioDe';
import { EMPTY_CUENTA, addItem, type CartaItem } from './cuenta';
import { FALLBACK_SECTIONS } from './sections';

// Cobro por el encargado: la pantalla «Servicio de Nerea» tras escanear su
// «Mi QR», y cómo la usa CobrarFlow (leyendo el código, como ui-cancelar).

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const nb = (text: string) => text.replace(/[\u00a0\u202f]€/g, ' €');
const noop = () => undefined;

const HORA: CartaItem = { id: 'c-1h', name: 'Servicio 1 h', priceCents: 6000, category: 'CHICA_SERVICE' };
const COPA: CartaItem = { id: 'c-copa', name: 'Copa', priceCents: 1000, category: 'VENUE_BAR' };

const ctx: CobrarContext = {
  user: { id: 'u1', email: 'a@b.c', role: 'MANAGER', tenantId: 't', venueSlug: 'v', displayName: 'Marta' },
  sections: FALLBACK_SECTIONS,
  allowed: null,
  post: null,
  defaultCategory: null,
  tips: true,
  methods: DEFAULT_PAYMENT_METHODS,
  night: DEFAULT_NIGHT_SETTINGS,
  rules: null,
  carta: [HORA, COPA],
  cartaLoaded: true,
  cartaFailed: false,
};

const nerea = { id: 'op-1', name: 'Nerea', photoHash: null };
// Dos servicios de 60 € y una copa de 10 €.
const cuenta = addItem(addItem(addItem(EMPTY_CUENTA, HORA), HORA), COPA);

function pantalla(onPos?: () => void) {
  return nb(
    renderToStaticMarkup(
      <ServicioDe ctx={ctx} who="Marta · Encargado" cuenta={cuenta} chica={nerea} onQr={noop} onPos={onPos} onOtra={noop} onBack={noop} busy={false} error={null} />,
    ),
  );
}

describe('«Servicio de Nerea»', () => {
  it('su nombre, lo de Servicios que se le apunta, el total y el aviso de una compañera por cobro', () => {
    const html = pantalla();
    expect(html).toContain('Servicio de Nerea');
    expect(html).toContain('Iniciales de Nerea');
    expect(html).toMatch(/Servicios: <b>120 €<\/b> → para Nerea/);
    expect(html).toMatch(/<span>Total<\/span><b>130 €<\/b>/);
    expect(html).toContain('Todo lo de Servicios va a Nerea. Si algún servicio es de otra compañera, quítalo de la cuenta y cóbralo aparte.');
    expect(html).toContain('QR o ficha');
    expect(html).toContain('Otra compañera');
  });

  it('«Tarjeta en el datáfono» solo si el local tiene datáfono', () => {
    expect(pantalla()).not.toContain('Tarjeta en el datáfono');
    expect(pantalla(noop)).toContain('Tarjeta en el datáfono');
  });
});

describe('CobrarFlow pide la compañera cuando el API lo dice', () => {
  const flow = read('../components/cobrar/CobrarFlow.tsx');
  /** El cuerpo de una función de CobrarFlow (de su cabecera hasta su «}» de cierre). */
  const body = (head: string): string => {
    const from = flow.indexOf(head);
    expect(from).toBeGreaterThan(-1);
    return flow.slice(from, flow.indexOf('\n  }\n', from));
  };

  it('al abrir el cobro, con datáfono y en «Otro QR · mismo importe»', () => {
    expect(body('async function start(')).toContain('needsCompanera(err)');
    expect(body('async function cobrarPos(')).toContain('needsCompanera(err)');
    expect(body('async function retry(')).toContain('needsCompanera(err)');
  });

  it('con datáfono se cobra la cuenta que recibe (la de «Otro importe» aún no está apuntada)', () => {
    expect(body('async function cobrarPos(')).toContain('lines: chargeLinesOf(c)');
  });

  it('«QR o ficha» apunta la cuenta solo si el cobro se abre', () => {
    expect(flow).toContain('cobrarYApuntar(stage.cuenta,');
    expect(flow).toContain('cobrarPos(stage.cuenta, stage.chica)');
  });

  it('a su nombre, la propina del PIN sale de servedTipsOn (la fila de Sala), no del puesto de quien cobra', () => {
    expect(body('function cobrarCuenta(')).toContain('tipsOn: chica ? servedTipsOn(ctx) : customerTipsOn(ctx)');
    expect(flow).toContain('serviceTips: mine.serviceTips ?? null');
  });

  it('«Otra compañera» vuelve al escáner con el QR de la que se descarta', () => {
    expect(flow).toContain("go({ kind: 'companera', cuenta: stage.cuenta, skipRaw: stage.chica.raw })");
    expect(flow).toContain('skipRaw={stage.skipRaw}');
  });

  it('el datáfono de quien no es compañera no le dice «Llama al camarero»', () => {
    expect(flow).toContain("byStaff={user.role !== 'OPERATOR'}");
    const active = read('../components/ActivePayment.tsx');
    expect(active).toContain('posWaitTexts(byStaff)');
  });
});

// Paso 7: el encargado y el dueño ven en Recepción → Incidencias los «No es mío» de las compañeras (los cierra el dueño).
describe('Recepción → Incidencias: «No es mío»', () => {
  it('llega con su tipo y dice que lo cierra el dueño en el panel', () => {
    expect(read('./api-incidencias.ts')).toContain("'service_disputed'");
    const inbox = read('../components/reception/ReceptionIncidents.tsx');
    expect(inbox).toContain("row.kind === 'service_disputed'");
    expect(inbox).toContain('Lo cierra el dueño en el panel. Habla con quien lo cobró.');
  });
});

describe('la propina de un servicio cobrado a su nombre', () => {
  const tipsOn = (over: Partial<CobrarContext>) => servedTipsOn({ ...ctx, ...over });

  it('sigue la fila de Sala (serviceTips), no el puesto de quien cobra', () => {
    // Sala sin propinas: aunque el encargado las lleve, el PIN no la ofrece (el API diría TIP_NOT_VALID).
    expect(tipsOn({ tips: true, serviceTips: false })).toBe(false);
    expect(tipsOn({ tips: false, serviceTips: true })).toBe(true);
  });

  it('sin el dato (un API de antes), su puesto; con las propinas del local apagadas, nunca', () => {
    expect(tipsOn({ tips: true, serviceTips: null })).toBe(true);
    expect(tipsOn({ tips: false })).toBe(false);
    expect(tipsOn({ serviceTips: true, methods: { ...DEFAULT_PAYMENT_METHODS, tips: false } })).toBe(false);
  });

  it('/venues/me → serviceTips (true, false o, sin el campo, null)', () => {
    expect(mySectionsOf({ myRights: { serviceTips: true } }).serviceTips).toBe(true);
    expect(mySectionsOf({ myRights: { serviceTips: false } }).serviceTips).toBe(false);
    expect(mySectionsOf({ myRights: {} }).serviceTips).toBeNull();
  });
});

describe('«Otra compañera»: el QR descartado no se vuelve a reconocer', () => {
  it('EscanearChica lo marca como rechazado al montar (hasta que se lea otro)', () => {
    const scan = read('../components/cobrar/EscanearChica.tsx');
    expect(scan).toMatch(/if \(skipRaw\) rejected\.current = rejectedQr\(skipRaw, 400, Date\.now\(\)\);/);
  });

  it('marcado así, ese QR no se vuelve a mandar; otro, sí', () => {
    const t = Date.now();
    const skipped = rejectedQr('np-staff:nerea', 400, t);
    expect(shouldResolveQr('np-staff:nerea', skipped, t + 60 * 60_000)).toBe(false);
    expect(shouldResolveQr('np-staff:lola', skipped, t)).toBe(true);
  });
});
