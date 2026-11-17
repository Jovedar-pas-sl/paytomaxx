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
    openMinute: 23 * 60,
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
/** Los importes llevan espacio duro (Intl) y «30&nbsp;%» también: aquí, espacio normal. */
const plain = (html: string) => html.replace(/&nbsp;|[\u00a0\u202f]/g, ' ');

describe('la página para reservar', () => {
  it('«30 %» no se parte en dos líneas: lleva espacio duro en las dos páginas', () => {
    const book = renderBookPage('ABCDEFGHIJKLMNOP', entry, '2026-11-16', '2027-03-16');
    const groupPage = renderGroupPage(TOKEN, group(), 'https://api.prueba.es', '2026-11-16', '2027-03-16');
    expect(book).toContain('Pagas la señal (30&nbsp;%) o todo');
    expect(book).toContain('</b> (30&nbsp;%)</p>');
    expect(groupPage).toContain('Pagar la señal (30&nbsp;%)');
    expect(book + groupPage).not.toContain('30 %');
  });

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
    expect(html).toContain('<b>Persona 1</b><span>ha gastado 50 €</span>');
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

  it('anulada por el local: lo pagado le queda como saldo para otra noche (con tarjeta o con bitcoin), con el enlace a su saldo', () => {
    const page = (r: Partial<ReservationView>, saldoHref: string | null = '/w/abc') =>
      plain(
        renderGroupPage(
          TOKEN,
          group({ payable: [], cancel: null, saldoHref }, { status: 'CANCELED', statusText: 'Anulada por el local', pendingCents: 0, ...r }),
          'https://api.prueba.es',
          '2026-11-16',
          '2027-03-16',
        ),
      );
    const card = page({ paidCents: 15000 });
    expect(card).toContain('El local ha anulado la reserva. Lo pagado (150 €) te queda como saldo para otra noche.');
    expect(card).toContain('href="/w/abc"');
    expect(card).not.toContain('bitcoin');
    // Lo pagado con bitcoin, igual: se queda como saldo (ya no «se devuelve en euros hablando con el local»).
    for (const bitcoin of [50000, 35000]) {
      const html = page({ paidCents: 50000, paidWithBitcoinCents: bitcoin });
      expect(html).toContain('El local ha anulado la reserva. Lo pagado (500 €) te queda como saldo para otra noche.');
      expect(html).not.toContain('bitcoin');
      expect(html).not.toContain('Habla con el local');
    }
    for (const html of [card, page({ paidCents: 50000, paidWithBitcoinCents: 50000 })]) expect(html).not.toMatch(/te devolver|te lo devuelven/);
    // Con el saldo ya gastado (sin enlace): la frase, sin botón.
    expect(page({ paidCents: 15000 }, null)).not.toContain('href="/w/');
    // Sin nada pagado, nada pasa a saldo.
    expect(page({ paidCents: 0 }, null)).not.toContain('te queda como saldo');
  });
});

describe('la página del reservado en el móvil (rediseño del 17-nov)', () => {
  const render = (over: Partial<GroupView> = {}, r: Partial<ReservationView> = {}, qrs: Record<number, string> = {}) =>
    plain(renderGroupPage(TOKEN, group(over, r), 'https://api.prueba.es', '2026-11-16', '2027-03-16', qrs));
  const paid = { status: 'PAID', statusText: 'Pagado', paidCents: 50000, pendingCents: 0 } as const;

  it('«Guarda tu reservado» arriba: calendario (.ics), WhatsApp (wa.me con el texto y el enlace) y «Copiar enlace»', () => {
    const html = render({ payable: [], cancel: 'Anular', canChangeDate: true }, paid);
    const url = `https://api.prueba.es/reservas/${TOKEN}`;
    expect(html).toContain('Guarda tu reservado');
    expect(html).toContain(`href="/reservas/${TOKEN}/calendario"`);
    expect(html).toContain('Añadir a mi calendario');
    const wa = html.match(/href="(https:\/\/wa\.me\/\?text=[^"]+)"/)?.[1];
    expect(wa).toBeTruthy();
    const text = decodeURIComponent(wa!.split('?text=')[1]!);
    expect(text).toContain('Sala Aurora');
    expect(text).toContain(url);
    expect(html).toContain('Enviármelo por WhatsApp');
    expect(html).toContain(`data-copy="${url}"`);
    expect(html).toContain('Copiar enlace');
    // Arriba: antes del resumen y de los QR; y ya no «Guarda este enlace» al final.
    expect(html.indexOf('Guarda tu reservado')).toBeLessThan(html.indexOf('Los QR de tu grupo'));
    expect(html.indexOf('Guarda tu reservado')).toBeLessThan(html.indexOf('<span>Noche</span>'));
    expect(html).not.toContain('Guarda este enlace');
    // Sin datos del cliente en el texto de WhatsApp.
    expect(text).not.toMatch(/Laura|600112233/);
  });

  it('sin «Guarda tu reservado» si ya llegó, se anuló o no vino', () => {
    for (const r of [{ status: 'ARRIVED' }, { status: 'CANCELED' }, { status: 'CLIENT_CANCELED' }, { status: 'NO_SHOW' }] as const) {
      expect(render({ payable: [], cancel: null }, r)).not.toContain('Guarda tu reservado');
    }
  });

  it('pagar: dos o tres líneas cortas y lo demás en «Ver condiciones»; el «Pagar» es lo único en lima', () => {
    const html = render();
    const pay = html.slice(html.indexOf('id="payf"'), html.indexOf('</form>', html.indexOf('id="payf"')));
    expect(pay).toContain('<details class="dis"><summary>Ver condiciones</summary>');
    const short = pay.slice(0, pay.indexOf('Ver condiciones'));
    expect(short).toContain('La señal (150 €) no se devuelve.');
    expect(short).toContain('Puedes cambiar la fecha una vez o anular, avisando con 48 horas.');
    expect(short).not.toContain('Si pagas todo y no vienes');
    const terms = pay.slice(pay.indexOf('Ver condiciones'));
    expect(terms).toContain('Si pagas todo y no vienes sin avisar con 48 horas, pierdes la señal y el resto queda como saldo para otra noche');
    expect(terms).toContain('Si el local anula la reserva, lo pagado te queda como saldo para otra noche.');
    expect((html.match(/class="btn"/g) ?? []).length).toBe(1);
    expect(pay).toContain('class="btn" id="payb"');
  });

  it('«Pagar el resto» sola, sin un botón de opción único; con dos opciones, a elegir', () => {
    const rest = render({ payable: ['REST'] }, { status: 'DEPOSIT_PAID', paidCents: 15000, pendingCents: 35000 });
    expect(rest).not.toContain('type="radio" name="kind"');
    expect(rest).toContain('<input type="hidden" name="kind" value="REST" data-eur="350 €">');
    const two = render();
    expect((two.match(/type="radio" name="kind"/g) ?? []).length).toBe(2);
  });

  it('cambiar la fecha y anular, plegados en «Cambiar o anular» (debajo de todo, nunca en lima)', () => {
    const html = render({ payable: ['REST'], cancel: 'Anular', canChangeDate: true }, { status: 'DEPOSIT_PAID', paidCents: 15000, pendingCents: 35000 });
    const more = html.indexOf('<details class="dis more"><summary>Cambiar o anular</summary>');
    expect(more).toBeGreaterThan(html.indexOf('id="payf"'));
    expect(html.indexOf('id="datef"')).toBeGreaterThan(more);
    expect(html.indexOf('id="cancelf"')).toBeGreaterThan(more);
    expect(html).toContain('class="btn alt" id="cancelb"');
    // Sin pagar, solo se puede cancelar: el pliegue lo dice así.
    expect(render()).toContain('<details class="dis more"><summary>Cancelar la reserva</summary>');
  });

  it('el grupo: una fila por persona con la miniatura de su QR y un «Compartir» grande (compartir del móvil o copiar)', () => {
    const html = render({ payable: [] }, paid, { 1: '<svg viewBox="0 0 1 1"></svg>', 2: '<svg viewBox="0 0 1 1"></svg>' });
    expect((html.match(/<span class="qr" aria-hidden="true"><svg /g) ?? []).length).toBe(2);
    expect(html).toContain('<a class="who" href="https://api.prueba.es/reservas/q/AAAAAAAAAAAAAAAAAAAAAAAA">');
    expect((html.match(/class="btn alt share" type="button" data-share="/g) ?? []).length).toBe(2);
    expect(html).toContain('navigator.share');
    expect(html).toContain('navigator.clipboard');
  });

  it('casillas grandes y campos que no hacen zoom ni se salen en el iPhone (16 px, fecha al 100 %)', () => {
    const book = renderBookPage('ABCDEFGHIJKLMNOP', entry, '2026-11-16', '2027-03-16');
    for (const html of [book, render()]) {
      expect(html).toMatch(/input\.i,textarea\.i\{[^}]*width:100%;min-width:0;[^}]*font-size:1rem;[^}]*-webkit-appearance:none;appearance:none/);
      expect(html).toMatch(/\.chk\{[^}]*min-height:3\.5rem/);
    }
    expect(book).not.toContain('class="card"><h2>Tu reservado');
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
