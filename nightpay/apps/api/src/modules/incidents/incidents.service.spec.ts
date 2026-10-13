import { afterEach, describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IncidentsService } from './incidents.service';
import { AlertsService } from './alerts.service';
import { TelegramService } from './telegram.service';
import type { Incident } from './incident-rules';

const at = (iso: string) => new Date(iso);

/** $queryRaw devuelve, en orden: atascados, dobles cobros, registros, noches, revisadas. */
function makeIncidents(rows: { stuck?: unknown[]; dup?: unknown[]; audit?: unknown[]; nights?: unknown[]; acks?: unknown[] }) {
  const prisma = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce(rows.stuck ?? [])
      .mockResolvedValueOnce(rows.dup ?? [])
      .mockResolvedValueOnce(rows.audit ?? [])
      .mockResolvedValueOnce(rows.nights ?? [])
      .mockResolvedValueOnce(rows.acks ?? []),
    incidentAck: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  return { svc: new IncidentsService(prisma as never, audit as never), prisma, audit };
}

describe('bandeja de incidencias', () => {
  it('junta atascados, dobles cobros, descuentos fallidos, wallets y noches; sin las revisadas', async () => {
    const { svc } = makeIncidents({
      stuck: [{ id: 'p-1', status: 'ORPHAN', amountCents: 500, updatedAt: at('2026-10-13T21:00:00Z') }],
      dup: [{ id: '7', paymentId: 'p-2', amountCents: 10_500, occurredAt: at('2026-10-13T22:00:00Z'), payload: {} }],
      audit: [
        { id: '8', action: 'refund.earning_reverse_failed', paymentId: 'p-3', amountCents: 100, occurredAt: at('2026-10-13T20:00:00Z'), payload: {} },
        { id: '9', action: 'wallet.credit_skipped_critical', paymentId: 'p-4', amountCents: 2000, occurredAt: at('2026-10-13T19:00:00Z'), payload: {} },
      ],
      nights: [{ id: 'n-1', closedAt: at('2026-10-14T06:00:00Z'), pendingAtClose: 1, autoClosed: true }],
      acks: [{ kind: 'wallet_credit_skipped', refId: '9' }],
    });
    const items = await svc.list('t-1');
    expect(items.map((i) => i.kind)).toEqual([
      'night_closed_pending',
      'duplicate_charge',
      'stuck_payment',
      'earning_reverse_failed',
    ]);
  });

  it('marcar como revisada: solo las que no se resuelven solas y que existen en este local', async () => {
    const dup = { id: '7', paymentId: 'p-2', amountCents: 100, occurredAt: at('2026-10-13T22:00:00Z'), payload: {} };
    const ok = makeIncidents({ dup: [dup] });
    await ok.svc.ack('t-1', 'owner', { kind: 'duplicate_charge', refId: '7', note: 'devuelto en BBVA' });
    expect(ok.prisma.incidentAck.upsert).toHaveBeenCalled();
    expect(ok.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'incident.acked' }));

    await expect(makeIncidents({}).svc.ack('t-1', 'owner', { kind: 'stuck_payment', refId: 'p-1' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      makeIncidents({}).svc.ack('t-1', 'owner', { kind: 'duplicate_charge', refId: 'otro' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('alertas por Telegram', () => {
  const incident = (refId: string): Incident => ({
    kind: 'duplicate_charge',
    refId,
    title: 'El cliente pagó dos veces',
    detail: 'Devuelve uno.',
    occurredAt: '2026-10-13T22:00:00.000Z',
    amountCents: 100,
    paymentId: 'p',
    ackable: true,
  });

  function makeAlerts(open: Incident[], cobros: unknown[] = []) {
    const claimed = new Set<string>();
    const redis = {
      set: vi.fn().mockImplementation(async (key: string) => {
        if (claimed.has(key)) return null;
        claimed.add(key);
        return 'OK';
      }),
      del: vi.fn().mockImplementation(async (key: string) => {
        claimed.delete(key);
        return 1;
      }),
    };
    const prisma = { venue: { findMany: vi.fn().mockResolvedValue([{ id: 't-1', name: 'Local Centro' }]) } };
    const incidents = { list: vi.fn().mockResolvedValue(open) };
    const reports = {
      cobros: vi.fn().mockResolvedValue(cobros),
      devoluciones: vi.fn().mockResolvedValue([]),
      liquidaciones: vi.fn().mockResolvedValue([]),
    };
    const telegram = { send: vi.fn().mockResolvedValue(true), isConfigured: () => true };
    const svc = new AlertsService(prisma as never, redis as never, incidents as never, reports as never, telegram as never);
    return { svc, telegram, reports };
  }

  it('cada incidencia se avisa una sola vez', async () => {
    const { svc, telegram } = makeAlerts([incident('1'), incident('2')]);
    const night = at('2026-10-13T23:00:00Z'); // 01:00 de Madrid: aún no toca el resumen
    await svc.tick(night);
    await svc.tick(night);
    expect(telegram.send).toHaveBeenCalledTimes(2);
    expect(telegram.send.mock.calls[0]![0]).toContain('Local Centro');
  });

  it('como mucho 10 avisos por vuelta', async () => {
    const many = Array.from({ length: 15 }, (_, i) => incident(String(i)));
    const { svc, telegram } = makeAlerts(many);
    await svc.tick(at('2026-10-13T23:00:00Z'));
    expect(telegram.send).toHaveBeenCalledTimes(10);
  });

  it('a partir de las 9:00, un resumen al día de la noche anterior (08:00 a 08:00)', async () => {
    const { svc, telegram, reports } = makeAlerts([incident('1')]);
    const morning = at('2026-10-14T07:30:00Z'); // 09:30 de Madrid
    await svc.tick(morning);
    await svc.tick(morning);
    const summaries = telegram.send.mock.calls.filter(([text]) => String(text).includes('anoche'));
    expect(summaries).toHaveLength(1);
    expect(reports.cobros).toHaveBeenCalledWith('t-1', {
      from: at('2026-10-13T06:00:00Z'),
      to: at('2026-10-14T06:00:00Z'),
    });
  });

  it('si Telegram falla, se reintenta en la siguiente vuelta (no se pierde)', async () => {
    const { svc, telegram } = makeAlerts([incident('1')]);
    telegram.send.mockResolvedValueOnce(false);
    const night = at('2026-10-13T23:00:00Z');
    await svc.tick(night);
    await svc.tick(night);
    await svc.tick(night);
    expect(telegram.send).toHaveBeenCalledTimes(2);
  });

  it('incidencias de hace más de 6 horas no se avisan (siguen en la bandeja)', async () => {
    const { svc, telegram } = makeAlerts([incident('viejo')]);
    await svc.tick(at('2026-10-14T05:00:00Z')); // 7 h después, aún antes de las 9:00
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('pasadas las 14:00 ya no se manda el resumen de la mañana', async () => {
    const { svc, telegram } = makeAlerts([], [{}]);
    await svc.tick(at('2026-10-14T13:00:00Z')); // 15:00 de Madrid
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('local sin cobros ni incidencias: no manda resumen', async () => {
    const { svc, telegram } = makeAlerts([]);
    await svc.tick(at('2026-10-14T07:30:00Z'));
    expect(telegram.send).not.toHaveBeenCalled();
  });
});

describe('Telegram', () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = (token?: string, chat?: string) => ({
    get: (k: string) => (k === 'TELEGRAM_BOT_TOKEN' ? token : k === 'TELEGRAM_CHAT_ID' ? chat : undefined),
  });

  it('sin token o chat no envía nada', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const t = new TelegramService(config(undefined, '123') as never);
    expect(t.isConfigured()).toBe(false);
    expect(await t.send('hola')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envía al chat del dueño; si Telegram falla, no rompe nada', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);
    const t = new TelegramService(config('TOKEN', '123') as never);
    expect(await t.send('hola')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]! as [string, { body: string }];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: '123', text: 'hola' });
    expect(await t.send('otra')).toBe(false);
  });
});
