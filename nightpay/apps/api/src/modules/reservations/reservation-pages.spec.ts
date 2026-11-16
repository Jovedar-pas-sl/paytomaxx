import { describe, expect, it } from 'vitest';
import type { ReservationView } from '@nightpay/contracts';
import { renderBookPage, renderGroupPage, renderGuestPage, renderReservationGone } from './reservation-pages';
import type { BookingEntry, GroupView } from './reservations.service';

const entry: BookingEntry = {
  venueId: 'v',
  venueName: 'Sala <Aurora>',
  source: 'WEB',
  promoter: null,
  problem: null,
  packages: [
    { id: 'p1', name: 'Mesa botellas', kind: 'ITEMS', priceCents: 30000, creditCents: 0, depositCents: 9000, entries: 6, items: [{ name: 'Botella', qty: 2 }], description: null, maxPerNight: null, active: true },
    { id: 'p2', name: 'Mesa consumo', kind: 'CREDIT', priceCents: 50000, creditCents: 40000, depositCents: 15000, entries: 4, items: [], description: 'Junto a la pista', maxPerNight: null, active: true },
  ],
};

function reservation(over: Partial<ReservationView> = {}): ReservationView {
  return {
    id: 'r1', ref: 'K7Q4M2', status: 'PENDING', statusText: 'Sin pagar', nightDate: '2026-11-21', previousNightDate: null, dateChanged: false,
    packageName: 'Mesa consumo', kind: 'CREDIT', priceCents: 50000, creditCents: 40000, depositCents: 15000, paidCents: 0, pendingCents: 50000,
    entries: 2, items: [], customerName: 'Laura', customerPhone: '600112233', notes: null, tableLabel: null, source: 'WEB', soldBy: 'Web',
    promoterName: null, balanceCents: null, itemsLeft: [], arrivedAt: null, noShowAuto: false, canceledAt: null, cancelReason: null, createdAt: '2026-11-16T10:00:00Z',
    guests: [
      { id: 'g1', seq: 1, label: null, checkedIn: false, spentCents: 0, items: [] },
      { id: 'g2', seq: 2, label: null, checkedIn: false, spentCents: 0, items: [] },
    ],
    ...over,
  };
}

function group(over: Partial<GroupView> = {}, r: Partial<ReservationView> = {}): GroupView {
  return {
    venueName: 'Sala Aurora',
    reservation: reservation(r),
    payable: ['DEPOSIT', 'FULL'],
    openPayUrl: null,
    canChangeDate: false,
    cancel: 'Cancelar',
    cancelBlocked: null,
    saldoHref: null,
    guestTokens: [
      { seq: 1, token: 'AAAAAAAAAAAAAAAAAAAAAAAA' },
      { seq: 2, token: 'BBBBBBBBBBBBBBBBBBBBBBBB' },
    ],
    ...over,
  };
}

const TOKEN = 'T'.repeat(32);
/** Los importes llevan espacio duro (Intl): aquí, espacio normal. */
const plain = (html: string) => html.replace(/[\u00a0\u202f]/g, ' ');

describe('la página para reservar', () => {
  it('los paquetes con su precio, lo que incluye y la señal del 30 %; el nombre del local escapado', () => {
    const html = plain(renderBookPage('ABCDEFGHIJKLMNOP', entry, '2026-11-16', '2027-03-16'));
    expect(html).toContain('Reserva en Sala &lt;Aurora&gt;');
    expect(html).toContain('6 personas · 2 × Botella');
    expect(html).toContain('400 € para consumir');
    expect(html).toContain('Señal para reservar: <b class="num">90 €</b> (30 %)');
    expect(html).toContain('min="2026-11-16" max="2027-03-16"');
    expect(html).toContain('"post":"/reservar/ABCDEFGHIJKLMNOP"');
  });

  it('sin poder reservar, lo dice y no hay formulario', () => {
    const html = renderBookPage('ABCDEFGHIJKLMNOP', { ...entry, problem: 'El local está cerrado ahora mismo' }, '2026-11-16', '2027-03-16');
    expect(html).toContain('El local está cerrado ahora mismo');
    expect(html).not.toContain('id="f"');
  });
});

describe('la página del reservado', () => {
  it('sin pagar: señal o todo, con el aviso claro de que la señal no se devuelve y la casilla «Lo entiendo»', () => {
    const html = plain(renderGroupPage(TOKEN, group(), 'https://api.prueba.es', '2026-11-16', '2027-03-16'));
    expect(html).toContain('Pagar la señal (30 %)');
    expect(html).toContain('Pagar todo ahora');
    expect(html).toContain('La señal (150 €) no se devuelve.');
    expect(html).toContain('Lo entiendo: la señal no se devuelve');
    expect(html).toContain('id="payb" type="submit" disabled');
    // Sin pagar no hay QR del grupo.
    expect(html).not.toContain('Los QR de tu grupo');
  });

  it('con la señal: el resto, los QR para compartir (uno por persona) y cambiar la fecha si aún puede', () => {
    const html = renderGroupPage(
      TOKEN,
      group({ payable: ['REST'], canChangeDate: true }, { status: 'DEPOSIT_PAID', statusText: 'Señal pagada', paidCents: 15000, pendingCents: 35000 }),
      'https://api.prueba.es',
      '2026-11-16',
      '2027-03-16',
    );
    expect(html).toContain('Pagar el resto');
    expect(html).toContain('Puedes pagar el resto ahora o al llegar al local.');
    expect(html).toContain('https://api.prueba.es/reservas/q/AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(html).toContain('data-share="https://api.prueba.es/reservas/q/BBBBBBBBBBBBBBBBBBBBBBBB"');
    expect(html).toContain('Solo una vez y avisando con 48 horas.');
  });

  it('ya en el local: lo que queda y lo que gasta cada uno; el saldo para otra noche', () => {
    const html = plain(renderGroupPage(
      TOKEN,
      group(
        { payable: [], saldoHref: '/w/abc' },
        {
          status: 'ARRIVED',
          statusText: 'Ha llegado',
          paidCents: 50000,
          pendingCents: 0,
          balanceCents: 35000,
          guests: [
            { id: 'g1', seq: 1, label: null, checkedIn: true, spentCents: 5000, items: [] },
            { id: 'g2', seq: 2, label: null, checkedIn: false, spentCents: 0, items: [] },
          ],
        },
      ),
      'https://api.prueba.es',
      '2026-11-16',
      '2027-03-16',
    ));
    expect(html).toContain('<p class="big">350 €</p>');
    expect(html).toContain('Persona 1 · ha gastado 50 €');
    expect(html).toContain('No caduca y no se devuelve en dinero.');
    expect(html).not.toContain('id="payf"');
  });

  it('anular: sin pagar, «Cancelar»; pagada con 48 h, «Anular» perdiendo la señal; sin las 48 h, no', () => {
    expect(renderGroupPage(TOKEN, group(), 'https://api.prueba.es', '2026-11-16', '2027-03-16')).toContain('Cancelar la reserva');
    const paid = plain(
      renderGroupPage(
        TOKEN,
        group({ payable: ['REST'], cancel: 'Anular' }, { status: 'PAID', statusText: 'Pagado', paidCents: 50000, pendingCents: 0 }),
        'https://api.prueba.es',
        '2026-11-16',
        '2027-03-16',
      ),
    );
    expect(paid).toContain('Anular mi reserva');
    expect(paid).toContain('Pierdes la señal (150 €).');
    expect(paid).toContain('Lo demás (350 €) te queda como saldo para otra noche');
    const late = renderGroupPage(
      TOKEN,
      group({ payable: [], cancel: null, cancelBlocked: 'Se anula avisando con 48 horas. Si no venís, se queda como «No vino».' }, { status: 'PAID', paidCents: 50000 }),
      'https://api.prueba.es',
      '2026-11-16',
      '2027-03-16',
    );
    expect(late).not.toContain('id="cancelf"');
    expect(late).toContain('Se anula avisando con 48 horas');
  });

  it('un pago a medias: «Seguir pagando»', () => {
    const html = renderGroupPage(TOKEN, group({ openPayUrl: '/pay/xyz' }), 'https://api.prueba.es', '2026-11-16', '2027-03-16');
    expect(html).toContain('href="/pay/xyz">Seguir pagando');
  });
});

describe('el QR de una persona y el enlace que no vale', () => {
  it('el QR, quién es y lo que queda', () => {
    const html = renderGuestPage(
      { venueName: 'Sala Aurora', token: 'x', seq: 2, entries: 6, packageName: 'Mesa botellas', nightDate: '2026-11-21', status: 'ARRIVED', statusText: 'Ha llegado', kind: 'ITEMS', balanceCents: 0, itemsLeft: [{ name: 'Botella', qty: 2, left: 1 }], mySpentCents: 0 },
      'data:image/png;base64,AAAA',
    );
    expect(html).toContain('Persona 2 de 6');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('<b class="num">1 de 2</b>');
  });

  it('404 sin pistas', () => {
    expect(renderReservationGone()).toContain('Este enlace no existe o ya no vale');
  });
});

describe('el pie legal', () => {
  it('lo llevan las cuatro páginas: reservar, la del reservado, el QR de una persona y el enlace que no vale', () => {
    const pages = [
      renderBookPage('ABCDEFGHIJKLMNOP', entry, '2026-11-16', '2027-03-16'),
      renderGroupPage(TOKEN, group(), 'https://api.prueba.es', '2026-11-16', '2027-03-16'),
      renderGuestPage(
        { venueName: 'Sala Aurora', token: 'x', seq: 1, entries: 2, packageName: 'Mesa consumo', nightDate: '2026-11-21', status: 'CONFIRMED', statusText: 'Pagada', kind: 'CREDIT', balanceCents: 0, itemsLeft: [], mySpentCents: 0 },
        'data:image/png;base64,AAAA',
      ),
      renderReservationGone(),
    ];
    for (const html of pages) {
      expect(html).toContain('<footer class="legal-foot"><nav aria-label="Textos legales">');
      for (const doc of ['aviso-legal', 'privacidad', 'cookies', 'condiciones']) expect(html).toContain(`href="/legal/${doc}?lang=es"`);
      expect(html).toContain('.legal-foot{');
      expect(html.indexOf('class="legal-foot"')).toBeGreaterThan(html.indexOf('</main>'));
    }
  });
});
