import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { ReservationView } from '@nightpay/contracts';
import { PublicReservationController } from './public-reservations.controller';
import type { ReservationCatalogService } from './reservation-catalog.service';
import type { GroupView, ReservationsService } from './reservations.service';

const TOKEN = 'T'.repeat(32);

function fakeReply() {
  const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header(k: string, v: string) {
      sent.headers[k] = v;
      return reply;
    },
    send(body?: string) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

function view(status: ReservationView['status']): GroupView {
  return {
    venueName: 'Sala Aurora',
    openMinute: 23 * 60,
    reservation: {
      id: 'r1', ref: 'K7Q4M2', status, statusText: 'Pagado', nightDate: '2026-11-21', previousNightDate: null, dateChanged: false,
      packageName: 'Mesa consumo', kind: 'CREDIT', priceCents: 50000, creditCents: 40000, depositCents: 15000, paidCents: 50000, pendingCents: 0,
      entries: 2, items: [], customerName: 'Laura', customerPhone: '600112233', notes: null, tableLabel: null, source: 'WEB', soldBy: 'Web',
      promoterName: null, balanceCents: null, itemsLeft: [], arrivedAt: null, noShowAuto: false, canceledAt: null, cancelReason: null, createdAt: '2026-11-16T10:00:00Z',
      guests: [
        { id: 'g1', seq: 1, label: null, checkedIn: false, spentCents: 0, items: [] },
        { id: 'g2', seq: 2, label: null, checkedIn: false, spentCents: 0, items: [] },
      ],
    },
    payable: [],
    openPayUrl: null,
    canChangeDate: false,
    cancel: null,
    cancelBlocked: null,
    saldoHref: null,
    guestTokens: [
      { seq: 1, token: 'A'.repeat(24) },
      { seq: 2, token: 'B'.repeat(24) },
    ],
  };
}

function controller(v: GroupView | null) {
  const reservations = { groupView: vi.fn().mockResolvedValue(v) } as unknown as ReservationsService;
  const catalog = { origin: 'https://api.prueba.es' } as unknown as ReservationCatalogService;
  return new PublicReservationController(reservations, catalog);
}

describe('GET /reservas/:token/calendario («Añadir a mi calendario»)', () => {
  it('un .ics de la noche del reservado, con el enlace de su página y sin datos del cliente', async () => {
    const { reply, sent } = fakeReply();
    await controller(view('PAID')).calendar(TOKEN, reply);
    expect(sent.status).toBe(200);
    expect(sent.headers['Content-Type']).toBe('text/calendar; charset=utf-8');
    expect(sent.headers['Content-Disposition']).toBe('attachment; filename="reservado.ics"');
    expect(sent.headers['Cache-Control']).toBe('no-store');
    const ics = (sent.body ?? '').replace(/\r\n /g, '');
    expect(ics).toContain('SUMMARY:Reservado en Sala Aurora');
    expect(ics).toContain('DTSTART:20261121T220000Z');
    expect(ics).toContain(`URL:https://api.prueba.es/reservas/${TOKEN}`);
    expect(ics).not.toMatch(/Laura|600112233/);
  });

  it('un enlace que no existe o un reservado anulado: 404 sin pistas', async () => {
    for (const v of [null, view('CANCELED'), view('CLIENT_CANCELED'), view('NO_SHOW'), view('ARRIVED')]) {
      const { reply, sent } = fakeReply();
      await controller(v).calendar(TOKEN, reply);
      expect(sent.status).toBe(404);
      expect(sent.body).toContain('Este enlace no existe o ya no vale');
    }
  });
});

describe('GET /reservas/:token (la página del grupo)', () => {
  it('lleva la miniatura del QR de cada persona (SVG del propio API, sin nada de fuera)', async () => {
    const { reply, sent } = fakeReply();
    await controller(view('PAID')).group(TOKEN, reply);
    expect(sent.status).toBe(200);
    const thumbs = (sent.body ?? '').match(/<span class="qr" aria-hidden="true"><svg /g) ?? [];
    expect(thumbs).toHaveLength(2);
    expect(sent.body).toContain(`href="/reservas/${TOKEN}/calendario"`);
  });
});
