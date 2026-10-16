import { afterEach, describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IncidentsService } from './incidents.service';
import { AlertsService } from './alerts.service';
import { TelegramService } from './telegram.service';
import { REFUND_PENDING_MINUTES, type Incident, type PendingRefundRow } from './incident-rules';

const at = (iso: string) => new Date(iso);

/**
 * $queryRaw devuelve, en orden: atascados, dobles cobros, registros, noches,
 * revisadas, datáfono (3), saldos (2), banco, avisos de cobro no dados por buenos
 * devoluciones sin confirmar y solicitudes de «Por aprobar» sin decidir.
 */
function makeIncidents(rows: {
  stuck?: unknown[];
  dup?: unknown[];
  audit?: unknown[];
  nights?: unknown[];
  acks?: unknown[];
  posMismatch?: unknown[];
  posUnmatched?: unknown[];
  posUnreconciled?: unknown[];
  walletsToClose?: unknown[];
  walletsLeftOpen?: unknown[];
  bankItems?: unknown[];
  anomalies?: unknown[];
  pendingRefunds?: unknown[];
  pendingApprovals?: unknown[];
}) {
  const prisma = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce(rows.stuck ?? [])
      .mockResolvedValueOnce(rows.dup ?? [])
      .mockResolvedValueOnce(rows.audit ?? [])
      .mockResolvedValueOnce(rows.nights ?? [])
      .mockResolvedValueOnce(rows.acks ?? [])
      .mockResolvedValueOnce(rows.posMismatch ?? [])
      .mockResolvedValueOnce(rows.posUnmatched ?? [])
      .mockResolvedValueOnce(rows.posUnreconciled ?? [])
      .mockResolvedValueOnce(rows.walletsToClose ?? [])
      .mockResolvedValueOnce(rows.walletsLeftOpen ?? [])
      .mockResolvedValueOnce(rows.bankItems ?? [])
      .mockResolvedValueOnce(rows.anomalies ?? [])
      .mockResolvedValueOnce(rows.pendingRefunds ?? [])
      .mockResolvedValueOnce(rows.pendingApprovals ?? []),
    incidentAck: { upsert: vi.fn().mockResolvedValue({}) },
    asSystem: vi.fn(),
  };
  prisma.asSystem.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
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

  it('datáfono: venta que no cuadra con el cobro y venta del cierre que no está en NightPay', async () => {
    const { svc } = makeIncidents({
      posMismatch: [
        {
          id: '21',
          paymentId: 'p-9',
          amountCents: null,
          occurredAt: at('2026-10-13T23:30:00Z'),
          payload: { operationNumber: '99812', message: 'El cobro ya no estaba abierto.' },
        },
      ],
      posUnmatched: [
        { id: 'op-1', paymentId: null, amountCents: 5000, occurredAt: at('2026-10-13T23:40:00Z'), payload: { operationNumber: '77' } },
      ],
    });
    const items = await svc.list('t-1');
    expect(items.map((i) => i.kind)).toEqual(['pos_unmatched_op', 'pos_charge_mismatch']);
    expect(items[0]!.detail).toContain('50,00 €');
    expect(items[1]!.detail).toContain('Operación 99812');
  });

  it('cobro del datáfono sin cuadrar en 24 h: se avisa y se quita solo al cuadrar', async () => {
    const { svc } = makeIncidents({
      posUnreconciled: [
        { id: 'p-7', paymentId: 'p-7', amountCents: 10_000, occurredAt: at('2026-10-12T22:00:00Z'), payload: { operationNumber: '55' } },
      ],
    });
    const [i] = await svc.list('t-1');
    expect(i).toMatchObject({ kind: 'pos_unreconciled', ackable: false, paymentId: 'p-7' });
    expect(i!.detail).toContain('Cuadrar con el datáfono');
  });

  it('saldo: el cliente pidió la devolución, o quedó saldo tras la noche (se quitan solas al devolverlo)', async () => {
    const { svc } = makeIncidents({
      walletsToClose: [{ id: 'w-1', shortCode: 'K7Q4M2', balanceCents: 8000, occurredAt: at('2026-10-14T01:00:00Z') }],
      walletsLeftOpen: [{ id: 'w-2', shortCode: 'ABCDEF', balanceCents: 2000, occurredAt: at('2026-10-13T01:00:00Z') }],
    });
    const items = await svc.list('t-1', at('2026-10-14T09:00:00Z'));
    expect(items.map((i) => [i.kind, i.ackable])).toEqual([
      ['wallet_close_requested', false],
      ['wallet_open_balance', false],
    ]);
    expect(items[0]!.detail).toContain('80,00 €');
    expect(items[0]!.detail).toContain('K7Q4M2');
  });

  it('cuadre con el banco: cada diferencia con su explicación, y se puede marcar como revisada', async () => {
    const { svc } = makeIncidents({
      bankItems: [
        {
          id: 'bi-1',
          status: 'NOT_IN_BANK',
          kind: 'SALE',
          operationAt: at('2026-10-13T21:18:59Z'),
          source: 'REDSYS',
          bankAmountCents: null,
          oursAmountCents: 6000,
          reference: '2610MLbhyfNg',
          authCode: null,
          paymentId: 'p-1',
          occurredAt: at('2026-10-13T21:18:59Z'),
        },
        {
          id: 'bi-2',
          status: 'AMOUNT_MISMATCH',
          kind: 'SALE',
          operationAt: at('2026-10-13T22:00:00Z'),
          source: 'PAYTEF',
          bankAmountCents: 5500,
          oursAmountCents: 5000,
          reference: '000077',
          authCode: 'A1B2C3',
          paymentId: 'p-2',
          occurredAt: at('2026-10-13T22:00:00Z'),
        },
      ],
    });
    const items = await svc.list('t-1', at('2026-10-14T09:00:00Z'));
    expect(items.map((i) => [i.kind, i.title, i.ackable])).toEqual([
      ['bank_mismatch', 'Importe distinto en el banco', true],
      ['bank_mismatch', 'Cobro que el banco no tiene', true],
    ]);
    expect(items[0]!.detail).toContain('Banco 55,00 € · aquí 50,00 €');
    expect(items[0]!.detail).toContain('Datáfono (Paytef)');
    expect(items[1]!.detail).toContain('no lo pagues a la chica');
    // Identificador estable: no depende de la línea (volver a subir conserva lo revisado).
    expect(items[1]!.refId).toBe('REDSYS|NOT_IN_BANK|SALE|2610MLbhyfNg|p-1||6000|');
  });

  it('avisos de cobro aprobado no dados por buenos: uno "sin comprobar" por cobro; importe distinto aparte', async () => {
    const anomaly = (id: string, eventType: string, paymentId: string, payload: Record<string, unknown>) => ({
      id,
      eventType,
      paymentId,
      amountCents: 5000,
      occurredAt: at(`2026-10-14T0${id.slice(-1)}:00:00Z`),
      payload,
    });
    const { svc } = makeIncidents({
      anomalies: [
        anomaly('903', 'payment.approval_unverified', 'p-1', { provider: 'PEANPE', providerTxId: 'ABC123' }),
        anomaly('902', 'payment.approval_unverified', 'p-1', { provider: 'PEANPE', providerTxId: 'ABC123' }),
        anomaly('901', 'payment.amount_mismatch', 'p-2', { provider: 'REDSYS', chargedCents: 100, expectedCents: 5000 }),
      ],
    });
    const items = await svc.list('t-1', at('2026-10-14T09:00:00Z'));
    expect(items.map((i) => [i.kind, i.refId, i.ackable])).toEqual([
      ['approval_unverified', 'p-1', false],
      ['amount_mismatch', '901', true],
    ]);
  });

  it('importe distinto se marca como revisado; "sin comprobar" no (se quita al resolver el cobro)', async () => {
    const row = {
      id: '901',
      eventType: 'payment.amount_mismatch',
      paymentId: 'p-2',
      amountCents: 5000,
      occurredAt: at('2026-10-14T01:00:00Z'),
      payload: { chargedCents: 100, expectedCents: 5000 },
    };
    const ok = makeIncidents({ anomalies: [row] });
    await ok.svc.ack('t-1', 'owner', { kind: 'amount_mismatch', refId: '901', note: 'devuelto' });
    expect(ok.prisma.incidentAck.upsert).toHaveBeenCalled();
    await expect(
      makeIncidents({}).svc.ack('t-1', 'owner', { kind: 'approval_unverified', refId: 'p-1' }),
    ).rejects.toThrow(BadRequestException);
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

describe('devoluciones sin confirmar (refund_pending)', () => {
  const NOW = at('2026-10-14T00:12:00Z');
  const pending = (over: Partial<PendingRefundRow> = {}): PendingRefundRow => ({
    id: 'r-1',
    paymentId: 'p-1',
    amountCents: 2500,
    paymentAmountCents: 8000,
    provider: 'PAYTEF',
    providerTxId: 'PT-7781',
    settleFailed: false,
    createdAt: at('2026-10-14T00:00:00Z'),
    ...over,
  });

  it('sale con texto para el dueño, el cobro y un refId estable (el id de la devolución)', async () => {
    const { svc } = makeIncidents({ pendingRefunds: [pending()] });
    const [i] = await svc.list('t-1', NOW);
    expect(i).toEqual({
      kind: 'refund_pending',
      refId: 'r-1',
      title: 'Devolución sin confirmar del banco',
      detail: expect.stringContaining('25,00 € del cobro de 80,00 € (pedido PT-7781), hace 12 min.'),
      occurredAt: '2026-10-14T00:00:00.000Z',
      amountCents: 2500,
      paymentId: 'p-1',
      ackable: false,
    });
    expect(i!.detail).toMatch(/Revisa en el panel de Paytef .*pulsa Resolver/);
    // El mismo refId en la siguiente vuelta, aunque el texto cambie ("hace 17 min").
    const { svc: later } = makeIncidents({ pendingRefunds: [pending()] });
    const [again] = await later.list('t-1', at('2026-10-14T00:17:00Z'));
    expect(again!.refId).toBe(i!.refId);
    expect(again!.detail).toContain('hace 17 min');
  });

  it('hecha en la pasarela pero sin apuntar (refund.settle_failed): pide marcarla como hecha', async () => {
    const { svc } = makeIncidents({ pendingRefunds: [pending({ settleFailed: true, provider: 'REDSYS' })] });
    const [i] = await svc.list('t-1', NOW);
    expect(i!.detail).toMatch(/El banco \(Redsys\) dice que la hizo.*Resolver → Hecha\. No la repitas\./);
  });

  it(`umbral: solo las PENDING de hace más de ${REFUND_PENDING_MINUTES} min (constante con nombre)`, async () => {
    expect(REFUND_PENDING_MINUTES).toBe(5);
    const { svc, prisma } = makeIncidents({});
    await svc.list('t-1', NOW);
    const call = prisma.$queryRaw.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('FROM refunds r'),
    ) as [TemplateStringsArray, ...unknown[]] | undefined;
    expect(call).toBeDefined();
    const sql = call![0].join('?');
    expect(sql).toContain("r.status = 'PENDING'");
    expect(sql).toMatch(/r\."createdAt" < \?/);
    expect(call!.slice(1)).toContainEqual(new Date(NOW.getTime() - REFUND_PENDING_MINUTES * 60 * 1000));
  });

  it('se quita sola al resolverla (ya no está PENDING) y no se puede marcar como revisada', async () => {
    const { svc } = makeIncidents({ pendingRefunds: [] });
    expect(await svc.list('t-1', NOW)).toEqual([]);
    await expect(makeIncidents({}).svc.ack('t-1', 'owner', { kind: 'refund_pending', refId: 'r-1' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('tiempo: minutos, luego horas y días', async () => {
    const { svc } = makeIncidents({
      pendingRefunds: [
        pending({ id: 'r-h', createdAt: at('2026-10-13T21:00:00Z') }),
        pending({ id: 'r-d', createdAt: at('2026-10-11T00:00:00Z') }),
      ],
    });
    const items = await svc.list('t-1', NOW);
    expect(items.find((i) => i.refId === 'r-h')!.detail).toContain('hace 3 h.');
    expect(items.find((i) => i.refId === 'r-d')!.detail).toContain('hace 3 días.');
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
      consumos: vi.fn().mockResolvedValue([]),
      pagosSaldo: vi.fn().mockResolvedValue([]),
    };
    const telegram = { send: vi.fn().mockResolvedValue(true), isConfigured: () => true };
    const svc = new AlertsService(prisma as never, redis as never, incidents as never, reports as never, telegram as never);
    return { svc, telegram, reports, incidents };
  }

  it('cada incidencia se avisa una sola vez', async () => {
    const { svc, telegram } = makeAlerts([incident('1'), incident('2')]);
    const night = at('2026-10-13T23:00:00Z'); // 01:00 de Madrid: aún no toca el resumen
    await svc.tick(night);
    await svc.tick(night);
    expect(telegram.send).toHaveBeenCalledTimes(2);
    expect(telegram.send.mock.calls[0]![0]).toContain('Local Centro');
  });

  it('devolución sin confirmar: se avisa una vez aunque el texto cambie en cada vuelta', async () => {
    const pendingRefund = (detail: string): Incident => ({
      kind: 'refund_pending',
      refId: 'r-1',
      title: 'Devolución sin confirmar del banco',
      detail,
      occurredAt: '2026-10-13T22:50:00.000Z',
      amountCents: 2500,
      paymentId: 'p-1',
      ackable: false,
    });
    const { svc, telegram, incidents } = makeAlerts([pendingRefund('… hace 10 min.')]);
    await svc.tick(at('2026-10-13T23:00:00Z'));
    incidents.list.mockResolvedValue([pendingRefund('… hace 15 min.')]);
    await svc.tick(at('2026-10-13T23:05:00Z'));
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send.mock.calls[0]![0]).toContain('Devolución sin confirmar del banco');
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
