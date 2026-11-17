import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MyPromoterReservation, MyPromoterView } from '@nightpay/contracts';
import { RrppHomeLink, RrppView, NotPromoter } from '@/components/rrpp/RrppView';
import { authedFetch } from './api';
import { commissionText, fetchMyPromoter, nightLabel, RRPP_PATH, statusTone, upcomingText } from './rrpp';

vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), authedFetch: vi.fn() }));

// «Tus reservas de RRPP» en la app del personal (/rrpp): su enlace con su QR,
// sus reservas sin nada del cliente y su comisión.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** Con los espacios finos del € y del % como espacios normales. */
const plain = (s: string): string => s.replace(/\s+/g, ' ');
/** El texto que se lee: sin etiquetas. */
const textOf = (el: Parameters<typeof renderToStaticMarkup>[0]): string => plain(renderToStaticMarkup(el).replace(/<[^>]+>/g, ' '));

const res = (o: Partial<MyPromoterReservation> = {}): MyPromoterReservation => ({
  ref: 'R-0007',
  nightDate: '2026-11-21',
  packageName: 'Mesa botellas',
  entries: 6,
  status: 'DEPOSIT_PAID',
  statusText: 'Señal pagada',
  priceCents: 30000,
  paidCents: 9000,
  pendingCents: 21000,
  commissionCents: 3000,
  commission: 'EXPECTED',
  ...o,
});

const view = (o: Partial<MyPromoterView> = {}): MyPromoterView => ({
  url: 'https://api.prueba.es/reservar/ABCDEFGHJKLM',
  commissionBps: 1000,
  earnedCents: 12000,
  toPayCents: 3000,
  paidCents: 9000,
  upcoming: [res()],
  recent: [res({ ref: 'R-0003', nightDate: '2026-11-14', status: 'ARRIVED', statusText: 'Ha llegado', paidCents: 30000, pendingCents: 0, commission: 'EARNED' })],
  ...o,
});

describe('los textos', () => {
  it('la noche, corta y sin depender del huso del móvil', () => {
    expect(nightLabel('2026-11-21')).toBe('sáb 21 nov');
    expect(nightLabel('2027-01-01')).toBe('vie 1 ene');
  });

  it('su comisión de cada reserva: ganada, cuando la paguen entera o ninguna', () => {
    expect(plain(commissionText(res({ commission: 'EARNED' })))).toBe('Tu comisión: 30 € (ganada)');
    expect(plain(commissionText(res({ commission: 'EXPECTED' })))).toBe('Tu comisión: 30 € cuando la paguen entera');
    expect(commissionText(res({ commission: 'NONE' }))).toBe('Sin comisión');
  });

  it('cuántas vienen', () => {
    expect(upcomingText(0)).toBe('Sin reservas para las próximas noches');
    expect(upcomingText(1)).toBe('1 reserva para las próximas noches');
    expect(upcomingText(3)).toBe('3 reservas para las próximas noches');
  });

  it('el color del estado: pagada o llegada en verde, a medias en ámbar, el resto apagado', () => {
    expect(statusTone('PAID')).toBe('success');
    expect(statusTone('ARRIVED')).toBe('success');
    expect(statusTone('DEPOSIT_PAID')).toBe('warning');
    expect(statusTone('PENDING')).toBe('mute');
    expect(statusTone('NO_SHOW')).toBe('mute');
    expect(statusTone('CANCELED')).toBe('mute');
  });
});

describe('la página', () => {
  it('su enlace entero, su QR, «Copiar» y cómo se usa', () => {
    const html = renderToStaticMarkup(<RrppView view={view()} />);
    expect(html).toContain('https://api.prueba.es/reservar/ABCDEFGHJKLM');
    expect(html).toMatch(/<svg role="img" aria-label="QR de tu enlace para reservar"/);
    expect(html).toContain('>Copiar<');
    expect(html).toContain('reservan con tu enlace');
  });

  it('sus reservas: referencia, noche, paquete, personas, estado e importes', () => {
    const text = textOf(<RrppView view={view()} />);
    for (const t of ['R-0007', 'sáb 21 nov', 'Mesa botellas · 6 personas', 'Señal pagada', 'Precio 300,00 €', 'Pagado 90,00 €', 'Falta 210,00 €', 'R-0003', 'Ha llegado']) {
      expect(text).toContain(t);
    }
    expect(text).toContain('Tu comisión: 30 € cuando la paguen entera');
    expect(text).toContain('Tu comisión: 30 € (ganada)');
  });

  it('nada del cliente aunque el servidor lo mandara por error', () => {
    const leaked = { ...res(), customerName: 'Laura Pérez', customerPhone: '+34600111222', notes: 'Cumpleaños', manageToken: 'tok-secreto' };
    const html = renderToStaticMarkup(<RrppView view={view({ upcoming: [leaked as MyPromoterReservation], recent: [] })} />);
    for (const t of ['Laura', '600111222', 'Cumpleaños', 'tok-secreto']) expect(html).not.toContain(t);
  });

  it('su comisión: su %, ganada, por cobrar y cobrada, y dónde se paga', () => {
    const text = textOf(<RrppView view={view()} />);
    expect(text).toContain('10 % del paquete');
    for (const t of ['Ganada en total 120,00 €', 'Por cobrar 30,00 €', 'Ya cobrada 90,00 €', '«Pagos a compañeras»']) expect(text).toContain(t);
  });

  it('sin reservas: lo dice', () => {
    const text = textOf(<RrppView view={view({ upcoming: [], recent: [] })} />);
    expect(text).toContain('Aún no hay reservas con tu enlace para las próximas noches.');
    expect(text).toContain('No hay reservas tuyas de las últimas noches.');
  });

  it('quien no es RRPP: un aviso amable y la vuelta a la app', () => {
    const html = renderToStaticMarkup(<NotPromoter />);
    expect(html).toContain('Esta página es para los RRPP del local');
    expect(html).toContain('href="/"');
  });
});

describe('la entrada en Inicio', () => {
  it('«Tus reservas de RRPP» lleva a /rrpp y dice cuántas vienen', () => {
    const html = renderToStaticMarkup(<RrppHomeLink upcoming={2} />);
    expect(RRPP_PATH).toBe('/rrpp');
    expect(html).toContain('href="/rrpp"');
    expect(html).toContain('Tus reservas de RRPP');
    expect(html).toContain('2 reservas para las próximas noches');
  });

  it('va arriba de la carta (sin tocar el menú del logo)', () => {
    expect(read('../components/HomeTab.tsx')).toContain('banner={<RrppHomeCard />}');
    expect(read('../components/cobrar/Carta.tsx')).toMatch(/<div className=\{styles\.body\}>\s*\{banner\}/);
  });
});

describe('fetchMyPromoter', () => {
  it('pide lo suyo (GET /v1/staff/me/promoter) y devuelve null si no es RRPP', async () => {
    vi.mocked(authedFetch).mockResolvedValue(new Response(JSON.stringify({ promoter: null }), { status: 200 }));
    await expect(fetchMyPromoter()).resolves.toBeNull();
    expect(authedFetch).toHaveBeenCalledWith('/v1/staff/me/promoter', { signal: undefined });
  });
});
