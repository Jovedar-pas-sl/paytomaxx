import { describe, expect, it, vi } from 'vitest';
import { RELEASE_LOCK_LUA } from '../../common/redis/release-lock';
import { OxioPaySettlementsService } from './oxiopay-settlements.service';
import {
  OxioPaySettlementsCron,
  alertKey,
  checkKey,
  doneKey,
  failedKey,
  failedMessage,
  findingsMessage,
  overdueMessage,
  type OverdueLine,
} from './oxiopay-settlements.cron';

const LOCK = 'np:oxiopay-settlements:lock';
/** Lunes 2-nov-2026 a las 10:30 de Madrid (09:30 UTC): toca la semana 44. */
const MONDAY_1030 = new Date('2026-11-02T09:30:00Z');

/** El Redis compartido por las réplicas: SET NX/EX, GET, EXISTS, DEL y el borrado condicional del candado. */
function sharedRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, ...opts: Array<string | number>): Promise<'OK' | null> => {
      if (opts.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    eval: vi.fn(async (script: string, _n: number, key: string, value: string) => {
      if (script !== RELEASE_LOCK_LUA) throw new Error('script inesperado');
      if (store.get(key) !== value) return 0;
      store.delete(key);
      return 1;
    }),
  };
}

function replica(
  redis: ReturnType<typeof sharedRedis>,
  opts: { runDue?: () => Promise<unknown>; overdue?: OverdueLine[]; telegramOk?: boolean; telegramOn?: boolean } = {},
) {
  const settlements = {
    runDue: vi.fn(opts.runDue ?? (async () => ({ week: { monday: '2026-10-26' }, created: ['OXP-2026-S44-A'], failed: [], findings: [] }))),
    overdueList: vi.fn(async () => opts.overdue ?? []),
  };
  const telegram = {
    isConfigured: vi.fn(() => opts.telegramOn ?? true),
    send: vi.fn(async () => opts.telegramOk ?? true),
  };
  return { cron: new OxioPaySettlementsCron(settlements as never, redis as never, telegram as never), settlements, telegram };
}

describe('repaso del lunes con dos réplicas (start-first): candado SET NX', () => {
  it('a la vez: solo una genera; la marca de «hecha» evita repetirla en las vueltas siguientes', async () => {
    const redis = sharedRedis();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = replica(redis, {
      runDue: async () => {
        await slow;
        return { week: { monday: '2026-10-26' }, created: ['OXP-2026-S44-A'], failed: [], findings: [] };
      },
    });
    const b = replica(redis);
    const first = a.cron.tick(MONDAY_1030);
    await vi.waitFor(() => expect(a.settlements.runDue).toHaveBeenCalledTimes(1));
    await b.cron.tick(MONDAY_1030);
    expect(b.settlements.runDue).not.toHaveBeenCalled();
    release();
    await first;
    // El candado se soltó y la semana quedó marcada.
    expect(redis.store.has(LOCK)).toBe(false);
    expect(redis.store.get(doneKey('2026-10-26'))).toBe('complete');
    await b.cron.tick(new Date(MONDAY_1030.getTime() + 10 * 60_000));
    expect(b.settlements.runDue).not.toHaveBeenCalled();
  });

  it('el lunes antes de las 10:00 no toca; con fallos en algún local, sin marca (se reintenta)', async () => {
    const redis = sharedRedis();
    const early = replica(redis);
    await early.cron.tick(new Date('2026-11-02T08:59:00Z'));
    expect(early.settlements.runDue).not.toHaveBeenCalled();
    const failing = replica(redis, { runDue: async () => ({ week: { monday: '2026-10-26' }, created: [], failed: ['v1: boom'], findings: [] }) });
    await failing.cron.tick(MONDAY_1030);
    expect(failing.settlements.runDue).toHaveBeenCalledTimes(1);
    expect(redis.store.has(doneKey('2026-10-26'))).toBe(false);
    await failing.cron.tick(new Date(MONDAY_1030.getTime() + 10 * 60_000));
    expect(failing.settlements.runDue).toHaveBeenCalledTimes(2);
  });

  it('si la primera vuelta es anterior al inicio, adelantarlo permite generar en la siguiente sin borrar Redis', async () => {
    const redis = sharedRedis();
    let startWeek = new Date('2026-11-09T00:00:00Z');
    const tx = {
      oxioPaySettlementSettings: {
        findUnique: vi.fn(async () => ({ id: 1, startWeek })),
        upsert: vi.fn(async ({ update }: { update: { startWeek: Date } }) => {
          startWeek = update.startWeek;
        }),
      },
      venue: { findMany: vi.fn(async () => [{ id: 'a', name: 'Luna' }]) },
      oxioPayPayee: { findUnique: vi.fn(async () => ({ name: 'OxioPay', iban: 'ES9121000418450200051332', holder: 'OxioPay demo', updatedAt: MONDAY_1030 })) },
    };
    const query = async (fn: (client: typeof tx) => unknown) => fn(tx);
    const service = new OxioPaySettlementsService({ asSystem: query, acrossVenues: query } as never, {} as never, {} as never);
    const generate = vi.spyOn(service, 'generate').mockResolvedValue({
      kind: 'created', id: 's1', reference: 'OXP-2026-S44-LUNA', totalCents: 100, replacesId: null,
    });
    vi.spyOn(service, 'reconcile').mockResolvedValue([]);
    const telegram = { isConfigured: () => false };
    const cron = new OxioPaySettlementsCron(service, redis as never, telegram as never);

    await cron.tick(MONDAY_1030);
    expect(generate).not.toHaveBeenCalled();
    const markedBeforeStart = redis.store.has(doneKey('2026-10-26'));
    await service.setStartWeek({ id: 'admin', email: 'admin@example.test' }, '2026-10-12');
    await cron.tick(new Date(MONDAY_1030.getTime() + 10 * 60_000));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(markedBeforeStart).toBe(false);
    expect(redis.store.get(doneKey('2026-10-26'))).toBe('complete');
    await cron.tick(new Date(MONDAY_1030.getTime() + 20 * 60_000));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('una marca antigua ambigua se repasa una vez solo para la semana que toca', async () => {
    const redis = sharedRedis();
    redis.store.set(doneKey('2026-10-19'), '1');
    redis.store.set(doneKey('2026-10-26'), '1');
    const r = replica(redis);

    await r.cron.tick(MONDAY_1030);
    expect(r.settlements.runDue).toHaveBeenCalledTimes(1);
    expect(redis.store.get(doneKey('2026-10-26'))).toBe('complete');
    expect(redis.store.get(doneKey('2026-10-19'))).toBe('1');
    await r.cron.tick(new Date(MONDAY_1030.getTime() + 10 * 60_000));
    expect(r.settlements.runDue).toHaveBeenCalledTimes(1);
  });

  it('un fallo inesperado no rompe la vuelta y suelta el candado', async () => {
    const redis = sharedRedis();
    const r = replica(redis, { runDue: async () => Promise.reject(new Error('base caída')) });
    await expect(r.cron.tick(MONDAY_1030)).resolves.toBeUndefined();
    expect(redis.store.has(LOCK)).toBe(false);
  });
});

describe('aviso de las que llevan más de 7 días sin pagar (Telegram del super-admin)', () => {
  const lines: OverdueLine[] = [
    { reference: 'OXP-2026-S44-LUNA', venueName: 'Luna', pendingCents: 2_235, daysOpen: 9 },
    { reference: 'OXP-2026-S44-SOL', venueName: 'Sol', pendingCents: 1_000, daysOpen: 8 },
  ];
  /** Martes 10-nov-2026 a las 12:00 de Madrid. */
  const TUESDAY_NOON = new Date('2026-11-10T11:00:00Z');

  it('una vez al día como mucho, aunque haya varias vueltas y réplicas', async () => {
    const redis = sharedRedis();
    redis.store.set(doneKey('2026-11-02'), 'complete');
    const a = replica(redis, { overdue: lines });
    const b = replica(redis, { overdue: lines });
    await a.cron.tick(TUESDAY_NOON);
    await b.cron.tick(new Date(TUESDAY_NOON.getTime() + 10 * 60_000));
    await a.cron.tick(new Date(TUESDAY_NOON.getTime() + 3 * 60 * 60_000));
    expect(a.telegram.send).toHaveBeenCalledTimes(1);
    expect(b.telegram.send).not.toHaveBeenCalled();
    expect(redis.store.has(alertKey('2026-11-10'))).toBe(true);
    // Al día siguiente, otra vez.
    await b.cron.tick(new Date('2026-11-11T11:00:00Z'));
    expect(b.telegram.send).toHaveBeenCalledTimes(1);
  });

  it('si Telegram falla, la marca se quita (se reintenta en la siguiente vuelta); de noche o sin bot, nada', async () => {
    const redis = sharedRedis();
    const failing = replica(redis, { overdue: lines, telegramOk: false });
    expect(await failing.cron.alertOverdue(TUESDAY_NOON)).toBe(false);
    expect(redis.store.has(alertKey('2026-11-10'))).toBe(false);
    const night = replica(redis, { overdue: lines });
    expect(await night.cron.alertOverdue(new Date('2026-11-10T22:30:00Z'))).toBe(false);
    const noBot = replica(redis, { overdue: lines, telegramOn: false });
    expect(await noBot.cron.alertOverdue(TUESDAY_NOON)).toBe(false);
    expect(noBot.settlements.overdueList).not.toHaveBeenCalled();
    const none = replica(redis, { overdue: [] });
    expect(await none.cron.alertOverdue(TUESDAY_NOON)).toBe(false);
    expect(none.telegram.send).not.toHaveBeenCalled();
  });

  it('el mensaje: cuántas, lo pendiente y una línea por liquidación (con el formateador de siempre)', () => {
    const text = overdueMessage(lines);
    expect(text).toContain('Liquidaciones sin pagar (más de 7 días)');
    expect(text).toContain('2 liquidaciones · pendiente 32,35\u00a0€');
    expect(text).toContain('• OXP-2026-S44-LUNA · Luna · 22,35\u00a0€ · 9 días');
    const many = overdueMessage(Array.from({ length: 12 }, (_, i) => ({ ...lines[0]!, reference: `OXP-${i}` })));
    expect(many).toContain('(y 2 más)');
  });
});

describe('ronda de revisión: avisos de fallos y de la comprobación, y el apagado', () => {
  it('si no se pudo emitir algún local (p. ej. las noches no cuadran), aviso una vez al día; la comprobación, una vez por semana', async () => {
    const redis = sharedRedis();
    const findings = [{ venueId: 'v', venueName: 'Luna', kind: 'outside_window' as const, cents: 95 }];
    const r = replica(redis, { runDue: async () => ({ week: { monday: '2026-10-26', isoWeek: 44, isoYear: 2026 }, created: [], failed: ['Luna: no cuadra'], findings }) });
    await r.cron.tick(MONDAY_1030);
    await r.cron.tick(new Date(MONDAY_1030.getTime() + 10 * 60_000));
    const texts = r.telegram.send.mock.calls.map((c) => String(c[0]));
    expect(texts.filter((t) => t.includes('sin emitir'))).toHaveLength(1);
    expect(texts.filter((t) => t.includes('Comprobación'))).toHaveLength(1);
    expect(redis.store.has(failedKey('2026-11-02'))).toBe(true);
    expect(redis.store.has(checkKey('2026-10-26'))).toBe(true);
    expect(redis.store.has(doneKey('2026-10-26'))).toBe(false);
  });

  it('los mensajes', () => {
    expect(failedMessage({ isoWeek: 44, isoYear: 2026 }, ['Luna: no cuadra'])).toContain('• Luna: no cuadra');
    const text = findingsMessage({ isoWeek: 44, isoYear: 2026 }, [
      { venueId: 'a', venueName: 'Luna', kind: 'outside_window', cents: -95 },
      { venueId: 'b', venueName: 'Sol', kind: 'closed_pending', cents: 2_000 },
      { venueId: 'c', venueName: 'Mar', kind: 'check_failed', cents: 0, detail: 'demasiados cobros' },
    ]);
    expect(text).toContain('Luna');
    expect(text).toContain('fuera de las 12 semanas');
    expect(text).toContain('dado de baja con liquidaciones sin pagar');
    expect(text).toContain('demasiados cobros');
  });

  it('al apagarse con una vuelta a medias: la espera (con tope) y suelta el candado', async () => {
    const redis = sharedRedis();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = replica(redis, {
      runDue: async () => {
        await slow;
        return { week: { monday: '2026-10-26' }, created: [], failed: [], findings: [] };
      },
    });
    const running = r.cron.tick(MONDAY_1030);
    await vi.waitFor(() => expect(r.settlements.runDue).toHaveBeenCalled());
    expect(redis.store.has(LOCK)).toBe(true);
    await r.cron.onModuleDestroy(20);
    // No terminó a tiempo: el candado se suelta (la réplica nueva no espera 30 min).
    expect(redis.store.has(LOCK)).toBe(false);
    release();
    await running;
    // Sin nada a medias, apagar no hace nada.
    await expect(r.cron.onModuleDestroy(20)).resolves.toBeUndefined();
  });
});
