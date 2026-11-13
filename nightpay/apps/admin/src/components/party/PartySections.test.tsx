import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PARTY_NOW, samplePerson, sampleLive, sampleSettlement, sampleStall } from '@/lib/party-fixtures';
import { CierreView, type CierreViewProps } from './CierreSection';
import { DevolucionesSection } from './DevolucionesSection';
import { PartyLiveView, type PartyLiveViewProps } from './PartyLiveSection';
import { PartySettingsView } from './PartySettingsSection';
import { PulserasSection } from './PulserasSection';
import { StallsView, type StallsViewProps } from './StallsSection';

/**
 * Las secciones del panel de OxioParty pintadas con datos de ejemplo (sin
 * DOM: el HTML que sale). En directo (cifras, avisos con su acción, casetas,
 * taquillas), Casetas, Cierre, La fiesta y los dos «Próximamente».
 */

const noop = () => undefined;
/** El HTML con los espacios duros de los importes como espacios normales y sin las marcas de React. */
const text = (html: string): string => html.replace(/\u00a0|&nbsp;/g, ' ').replace(/<!-- -->/g, '');

beforeEach(() => {
  vi.stubGlobal('React', React);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function live(props: Partial<PartyLiveViewProps> = {}): string {
  return text(
    renderToStaticMarkup(
      <PartyLiveView
        live={sampleLive()}
        error={null}
        eventName="Fiestas de San Juan 2027"
        timeZone="Europe/Madrid"
        now={PARTY_NOW}
        selection={{ scope: 'night' }}
        onSelect={noop}
        idleMinutes={15}
        onIdleMinutes={noop}
        onRetry={noop}
        onNavigate={noop}
        {...props}
      />,
    ),
  );
}

describe('En directo', () => {
  const html = live();

  it('la fiesta, sus noches y «En directo · 01:47»', () => {
    expect(html).toContain('Fiestas de San Juan 2027');
    expect(html).toContain('Del 23 jun, 20:00 al 25 jun, 06:00 · 4 casetas · 2 taquillas');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Noche 1</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Toda la fiesta</);
    expect(html).toContain('En directo · 01:47');
  });

  it('las cuatro cifras de arriba, con la de las pulseras en oscuro', () => {
    for (const s of ['Cargado', '18.450,00 €', 'Vendido', '14.120,00 €', 'Aún en las pulseras', '4.330,00 €', 'Pulseras activas', '1212', '+1.240,00 € en la última hora']) {
      expect(html).toContain(s);
    }
    expect(html).toMatch(/data-dark="true"><p class="np-party-kpi-label">Aún en las pulseras/);
  });

  it('las horas, con la gráfica leída en voz alta', () => {
    expect(html).toContain('Ventas por hora');
    expect(html).toContain('role="img" aria-label="Ventas por hora: 20 h 620,00 €');
    expect(html).toContain('3,1 k');
  });

  it('los avisos con su acción: ver las taquillas y llamar al responsable', () => {
    expect(html).toContain('Lucía: 6.200,00 € en efectivo');
    expect(html).toContain('Caseta Los del Barrio: sin cobros desde hace 27 min');
    expect(html).toContain('href="tel:611111111"');
    expect(html).toContain('Llamar a Asociación de vecinos');
    expect(html).toContain('Ver las taquillas');
    expect(html).toContain('aria-label="2 avisos"');
    expect(html).toContain('aria-label="Minutos sin cobros para avisar"');
  });

  it('las casetas por lo vendido, con su % y su estado; las taquillas y el móvil', () => {
    const list = html.slice(html.indexOf('id="np-party-h-stalls"'));
    expect(list.indexOf('Peña El Cántaro')).toBeLessThan(list.indexOf('Caseta Los del Barrio'));
    expect(list.indexOf('Caseta Los del Barrio')).toBeLessThan(list.indexOf('Barra de la Comisión'));
    expect(html).toContain('Barra propia');
    expect(html).toContain('Sin cobros · 27 min');
    expect(html).toContain('Sin cobros aún');
    expect(html).toContain('De dónde entra el dinero');
    expect(html).toContain('Efectivo 6.240,00 € · tarjeta 4.180,00 € · en la caja 6.200,00 €');
    expect(html).toContain('Desde el móvil');
    expect(html).not.toMatch(/chica|en línea|sin conexión/i);
  });

  it('cargando: siluetas; con error, el aviso y «Reintentar»; sin avisos, en orden', () => {
    expect(live({ live: null })).toContain('Cargando el directo');
    expect(live({ live: null, error: 'Sin conexión con el servidor' })).toContain('No se pudo cargar el directo: Sin conexión con el servidor');
    expect(live({ live: sampleLive({ alerts: [] }) })).toContain('Todo en orden');
    expect(live({ live: sampleLive({ alerts: [], live: false, lastHour: null }) })).toContain('Los avisos salen en la noche en curso.');
  });
});

function stalls(props: Partial<StallsViewProps> = {}): string {
  return text(
    renderToStaticMarkup(
      <StallsView
        stalls={[sampleStall(), sampleStall({ id: 's-2', name: 'Barra de la Comisión', organizerBps: 10_000, ownBar: true, iban: null, staffCount: 0 }), sampleStall({ id: 's-3', name: 'Churrería', iban: null, active: false })]}
        staff={[samplePerson(), samplePerson({ id: 'u-2', displayName: null, email: 'ana@fiesta.es', role: 'OPERATOR', stallId: null })]}
        editing={null}
        notice={null}
        onNew={noop}
        onEdit={noop}
        onCancel={noop}
        onSaved={noop}
        onToggleActive={noop}
        onRemove={noop}
        onAssign={noop}
        {...props}
      />,
    ),
  );
}

describe('Casetas', () => {
  it('la lista con su %, su IBAN tapado o «Falta IBAN», su personal y su estado', () => {
    const html = stalls();
    expect(html).toContain('Casetas y barras');
    expect(html).toContain('Peña El Cántaro');
    expect(html).toContain('Ana R. · 600 000 000');
    expect(html).toContain('10 %');
    expect(html).toContain('ES91 •••• •••• 1332');
    expect(html).toContain('No se paga');
    expect(html).toContain('Falta IBAN');
    expect(html).toContain('Archivada');
    expect(html).toContain('Reactivar');
    expect(html).not.toContain('ES9121000418450200051332');
  });

  it('el personal con su caseta (solo las activas para elegir) y sin «chica»', () => {
    const html = stalls();
    expect(html).toContain('El personal de cada caseta');
    expect(html).toContain('aria-label="Caseta de Toni"');
    expect(html).toContain('Personal');
    expect(html).not.toMatch(/<option value="s-3"/);
    expect(html).not.toMatch(/chica/i);
  });

  it('nueva caseta: el formulario con el % y la barra propia', () => {
    const html = stalls({ editing: { kind: 'new' } });
    expect(html).toContain('Nueva caseta');
    expect(html).toContain('% para la organización');
    expect(html).toContain('Barra propia (todo para la organización; no se le paga)');
    expect(html).toContain('IBAN para pagarle');
    expect(html).toContain('Dar de alta');
  });

  it('cambiar una: con sus datos y «Activa»', () => {
    const html = stalls({ editing: { kind: 'edit', stall: sampleStall() } });
    expect(html).toContain('Cambiar «Peña El Cántaro»');
    expect(html).toContain('value="ES9121000418450200051332"');
    expect(html).toContain('value="10,00"');
    expect(html).toContain('Activa (se le puede dar personal y cobrar)');
  });

  it('sin casetas, cómo empezar', () => {
    expect(stalls({ stalls: [], staff: [] })).toContain('Aún no hay casetas.');
  });
});

function cierre(props: Partial<CierreViewProps> = {}): string {
  return text(
    renderToStaticMarkup(
      <CierreView
        data={sampleSettlement()}
        settings={{ eventStartsAt: null, eventEndsAt: '2027-06-25T04:00:00.000Z', refundDeadline: '2027-07-15', allowDonation: true, cashAlertCents: 200_000, eventEnded: true }}
        error={null}
        timeZone="Europe/Madrid"
        range={{}}
        onRange={noop}
        onRetry={noop}
        onDownload={noop}
        downloading={null}
        downloadError={null}
        {...props}
      />,
    ),
  );
}

describe('Cierre', () => {
  it('la tabla por caseta con los totales y las transferencias', () => {
    const html = cierre();
    expect(html).toContain('Cierre: lo que se paga a cada caseta');
    expect(html).toContain('Terminada el 25 jun, 06:00.');
    for (const s of ['7.920,00 €', '792,00 €', '7.128,00 €', 'IBAN listo', 'Falta IBAN', 'No se paga', '13.020,00 €', '4.199,20 €', '8.820,80 €', '1 transferencia · 7.128,00 €']) {
      expect(html).toContain(s);
    }
  });

  it('los botones: transferencias para el banco y CSV; el aviso de la que no tiene IBAN', () => {
    const html = cierre();
    expect(html).toMatch(/<button[^>]*>(?:<[^>]+>)*Descargar transferencias para el banco/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:<[^>]+>)*Descargar transferencias/);
    expect(html).toContain('Descargar CSV');
    expect(html).toContain('1 caseta no tiene IBAN: no van en el fichero.');
  });

  it('sin la cuenta del local, el fichero del banco no se puede descargar', () => {
    const html = cierre({ data: sampleSettlement({ debtor: { name: 'X', ibanMasked: null } }) });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:<[^>]+>)*Descargar transferencias para el banco/);
    expect(html).toContain('la pone OxioPay');
  });

  it('lo que sobró en las pulseras, con el plazo para pedirlo', () => {
    const html = cierre();
    expect(html).toContain('Lo que sobró en las pulseras');
    expect(html).toContain('1.980,00 €');
    expect(html).toContain('Devuelto: 1.200,00 €');
    expect(html).toContain('Aún en las pulseras: 780,00 € (se puede pedir hasta el 15/07/2027)');
  });

  it('la fiesta entera o unas noches', () => {
    expect(cierre()).toMatch(/aria-pressed="true"[^>]*>Toda la fiesta</);
    const nights = cierre({ range: { from: '2027-06-23', to: '2027-06-24' } });
    expect(nights).toMatch(/aria-pressed="true"[^>]*>Unas noches</);
    expect(nights).toContain('Primera noche');
    expect(nights).toContain('Cada noche va de las 08:00 de ese día a las 08:00 del siguiente.');
  });
});

describe('La fiesta (Ajustes)', () => {
  const settings = {
    eventStartsAt: '2027-06-23T18:00:00.000Z',
    eventEndsAt: '2027-06-25T04:00:00.000Z',
    refundDeadline: '2027-07-15',
    allowDonation: true,
    cashAlertCents: 200_000,
    eventEnded: false,
  };

  it('el dueño: las fechas en la hora del local, la devolución, donar y el aviso de efectivo', () => {
    const html = text(renderToStaticMarkup(<PartySettingsView settings={settings} onSaved={noop} isOwner />));
    expect(html).toContain('value="2027-06-23T20:00"');
    expect(html).toContain('value="2027-06-25T06:00"');
    expect(html).toContain('value="2027-07-15"');
    expect(html).toContain('Dejar donarlo a la organización');
    expect(html).toContain('value="2000,00"');
    expect(html).toContain('Guardar');
  });

  it('el encargado la ve, pero no la cambia', () => {
    const html = text(renderToStaticMarkup(<PartySettingsView settings={settings} onSaved={noop} isOwner={false} />));
    expect(html).toContain('Solo el dueño puede cambiar la fiesta.');
    expect(html).not.toContain('>Guardar<');
    expect(html).toMatch(/disabled=""[^>]*value="2027-06-23T20:00"|value="2027-06-23T20:00"[^>]*disabled=""/);
  });
});

describe('Pulseras y Devoluciones: su sitio, «Próximamente»', () => {
  it('se pintan sin datos', () => {
    expect(renderToStaticMarkup(<PulserasSection />)).toContain('Próximamente');
    expect(renderToStaticMarkup(<DevolucionesSection />)).toContain('Próximamente');
  });
});
