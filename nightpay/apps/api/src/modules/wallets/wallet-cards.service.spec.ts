import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WalletCardsService, cardRow } from './wallet-cards.service';
import { frozenFichas } from './fichas-counts';

/**
 * Stock de fichas de un local: «Preparar fichas» (grabar en blanco y apuntar
 * en el stock, devolver las de saldos gastados, apartar las que no), la lista
 * del panel con búsqueda, el resumen por noche y bloquear / marcar perdida.
 */

type Row = Record<string, unknown>;

const NOW = new Date('2026-10-21T02:00:00+02:00');
const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01';
const NORTE = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a02'; // mismo grupo
const NEON = '8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c03'; // otro dueño
const JAVI = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03';
const W_CON = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'; // saldo con dinero
const W_GASTADO = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f71';

const tok = (c: string) => `${c.repeat(4)}FichaDeLaSala01`;

function setup(o: { nfc?: boolean } = {}) {
  const cards = new Map<string, Row>();
  const put = (row: Row) => {
    const full = {
      uid: null, walletId: null, status: 'STOCK', venueId: SALA, linkedById: null, createdAt: NOW, stockedAt: NOW,
      linkedAt: null, returnedAt: null, lostAt: null, blockedAt: null, lastUsedAt: null, ...row,
    };
    cards.set(String(full.id), full);
    return full;
  };
  const wallets = new Map<string, Row>([
    [W_CON, { id: W_CON, tenantId: SALA, walletGroup: 'grupo', status: 'ACTIVE', balanceCents: 4_000, shortCode: 'K7Q4M2' }],
    [W_GASTADO, { id: W_GASTADO, tenantId: SALA, walletGroup: 'grupo', status: 'DEPLETED', balanceCents: 0, shortCode: 'P9X3T7' }],
  ]);
  const venues = new Map<string, Row>([
    [SALA, { id: SALA, walletGroup: 'grupo', paymentMethods: o.nfc === false ? { nfc: false } : null }],
    [NORTE, { id: NORTE, walletGroup: 'grupo', paymentMethods: null }],
    [NEON, { id: NEON, walletGroup: 'otro', paymentMethods: null }],
  ]);
  const byToken = (t: unknown) => [...cards.values()].find((c) => c.token === t);
  const events: Row[] = [];
  const tx = {
    // Los códigos sin grabar de hace más de un día se borran al pedir uno nuevo.
    $executeRaw: vi.fn(async () => 0),
    walletCardEvent: {
      createMany: vi.fn(async (a: { data: Row[] }) => {
        events.push(...a.data);
        return { count: a.data.length };
      }),
      // El último «perdida» de la ficha (¿sustituida o marcada desde el panel?).
      findFirst: vi.fn(async (a: { where: { cardId: string; kind: string } }) =>
        [...events].reverse().find((e) => e.cardId === a.where.cardId && e.kind === a.where.kind) ?? null,
      ),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('WHERE token =')) {
        const c = byToken(values[0]);
        return c ? [{ id: c.id, uid: c.uid, walletId: c.walletId, status: c.status, venueId: c.venueId }] : [];
      }
      return [];
    }),
    venue: { findUnique: vi.fn(async (a: { where: { id: string } }) => venues.get(a.where.id) ?? null) },
    clientWallet: {
      findUnique: vi.fn(async (a: { where: { id: string } }) => wallets.get(a.where.id) ?? null),
      findMany: vi.fn(async (a: { where: { shortCode: string } }) => [...wallets.values()].filter((w) => w.shortCode === a.where.shortCode)),
    },
    walletCard: {
      create: vi.fn(async (a: { data: Row }) => put({ id: `card-${cards.size + 1}`, stockedAt: null, ...a.data })),
      findUnique: vi.fn(async (a: { where: { id: string }; include?: unknown; select?: Row }) => {
        const c = cards.get(a.where.id);
        if (!c) return null;
        const w = c.walletId ? wallets.get(String(c.walletId)) : null;
        return { ...c, wallet: w ? { shortCode: w.shortCode, tenantId: w.tenantId, walletGroup: w.walletGroup } : null };
      }),
      update: vi.fn(async (a: { where: { id: string }; data: Row }) => put({ ...cards.get(a.where.id), ...a.data })),
      updateMany: vi.fn(async (a: { where: { id: string; status: string }; data: Row }) => {
        const c = cards.get(a.where.id);
        if (!c || c.status !== a.where.status) return { count: 0 };
        put({ ...c, ...a.data });
        return { count: 1 };
      }),
      findMany: vi.fn(async () => [...cards.values()].map((c) => ({ ...c, wallet: c.walletId ? wallets.get(String(c.walletId)) : null }))),
      count: vi.fn(async () => 0),
    },
    venueNight: { findMany: vi.fn(async () => [] as Row[]) },
  };
  const run = async (fn: (t: typeof tx) => unknown) => fn(tx);
  const prisma = { venue: tx.venue, asSystem: vi.fn(run), acrossVenues: vi.fn(run) };
  const audit = { log: vi.fn(async (_e: Record<string, unknown>) => undefined) };
  const svc = new WalletCardsService(prisma as never, audit as never);
  return { svc, cards, put, tx, audit, events };
}

const recepcion = { userId: null, terminalId: 'term-recepcion' };
const javi = { userId: JAVI, role: 'MANAGER' as const, tenantId: SALA };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('«Preparar fichas»: tap, tap, tap', () => {
  it('código nuevo del servidor para cada ficha vacía: en el stock del local, aún sin grabar', async () => {
    const { svc, cards } = setup();
    const a = await svc.newStockToken(SALA, recepcion);
    const b = await svc.newStockToken(SALA, recepcion);
    expect(a.card).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.card).not.toBe(b.card);
    expect([...cards.values()].find((c) => c.token === a.card)).toMatchObject({ status: 'STOCK', venueId: SALA, stockedAt: null, linkedById: null });
  });

  it('recién grabada → al stock (con su número de serie); acercarla otra vez no la cuenta dos veces', async () => {
    const { svc, cards, audit } = setup();
    const { card } = await svc.newStockToken(SALA, recepcion);
    await expect(svc.stock(SALA, recepcion, { card, uid: '04:a2:3b:5c:1d:80:11' })).resolves.toEqual({ outcome: 'stocked' });
    const row = [...cards.values()].find((c) => c.token === card)!;
    expect(row).toMatchObject({ status: 'STOCK', uid: '04A23B5C1D8011', stockedAt: NOW, venueId: SALA });
    await expect(svc.stock(SALA, recepcion, { card, uid: '04A23B5C1D8011' })).resolves.toEqual({ outcome: 'already' });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.card_stocked', tenantId: SALA, actorId: null, payload: { withUid: true, terminalId: 'term-recepcion' } }),
    );
  });

  it('una ficha ya grabada de un saldo con dinero: se aparta y dice de quién es; de un saldo gastado, vuelve al stock', async () => {
    const { svc, put, cards } = setup();
    put({ id: 'card-con', token: tok('A'), walletId: W_CON, status: 'ISSUED', linkedAt: NOW });
    put({ id: 'card-gastada', token: tok('B'), walletId: W_GASTADO, status: 'ISSUED', linkedAt: NOW });
    await expect(svc.stock(SALA, recepcion, { card: tok('A') })).resolves.toEqual({ outcome: 'in-use', codeHint: 'K7Q-•••' });
    expect(cards.get('card-con')).toMatchObject({ status: 'ISSUED', walletId: W_CON });
    await expect(svc.stock(SALA, recepcion, { card: tok('B') })).resolves.toEqual({ outcome: 'returned', codeHint: 'P9X-•••' });
    expect(cards.get('card-gastada')).toMatchObject({ status: 'RETURNED', walletId: null, returnedAt: NOW, venueId: SALA });
  });

  it('perdida, bloqueada, copiada, de otro dueño o que no es nuestra: se aparta sin tocarla', async () => {
    const { svc, put, cards } = setup();
    // Marcada perdida desde el panel: sigue siendo del cliente (su saldo).
    put({ id: 'perdida', token: tok('C'), status: 'LOST', walletId: W_CON });
    put({ id: 'bloqueada', token: tok('D'), status: 'BLOCKED' });
    put({ id: 'con-uid', token: tok('E'), uid: '04A23B5C1D8000' });
    put({ id: 'de-neon', token: tok('F'), venueId: NEON });
    await expect(svc.stock(SALA, recepcion, { card: tok('C') })).resolves.toEqual({ outcome: 'lost' });
    await expect(svc.stock(SALA, recepcion, { card: tok('D') })).resolves.toEqual({ outcome: 'blocked' });
    await expect(svc.stock(SALA, recepcion, { card: tok('E'), uid: '04FFFFFFFFFF01' })).resolves.toEqual({ outcome: 'foreign' });
    await expect(svc.stock(SALA, recepcion, { card: tok('F') })).resolves.toEqual({ outcome: 'foreign' });
    await expect(svc.stock(SALA, recepcion, { card: tok('G') })).resolves.toEqual({ outcome: 'foreign' });
    await expect(svc.stock(SALA, recepcion, { card: 'no/es/nuestra' })).resolves.toEqual({ outcome: 'foreign' });
    expect(cards.get('de-neon')).toMatchObject({ venueId: NEON });
  });

  it('la sustituida al dar otra al mismo saldo (perdida, sin saldo) aparece: vuelve al stock con su evento', async () => {
    const { svc, put, cards, events } = setup();
    put({ id: 'sustituida', token: tok('H'), status: 'LOST', walletId: null, lostAt: NOW });
    events.push({ cardId: 'sustituida', kind: 'LOST', walletId: W_CON, byUserId: null, terminalId: null });
    await expect(svc.stock(SALA, recepcion, { card: tok('H') })).resolves.toEqual({ outcome: 'returned', codeHint: '•••-•••' });
    expect(cards.get('sustituida')).toMatchObject({ status: 'RETURNED', venueId: SALA, returnedAt: NOW });
    expect(events.at(-1)).toEqual(expect.objectContaining({ cardId: 'sustituida', kind: 'RETURNED', venueId: SALA, terminalId: 'term-recepcion' }));
    // Una del stock marcada perdida desde el panel no vuelve sola: la recupera el encargado.
    put({ id: 'perdida-panel', token: tok('L'), status: 'LOST', walletId: null, lostAt: NOW });
    events.push({ cardId: 'perdida-panel', kind: 'LOST', walletId: null, byUserId: JAVI, terminalId: null });
    await expect(svc.stock(SALA, recepcion, { card: tok('L') })).resolves.toEqual({ outcome: 'lost' });
  });

  it('del API anterior (ACTIVE): con saldo gastado vuelve al stock; sin saldo, queda en el stock como STOCK', async () => {
    const { svc, put, cards, events } = setup();
    put({ id: 'vieja-dada', token: tok('J'), status: 'ACTIVE', walletId: W_GASTADO });
    put({ id: 'vieja-libre', token: tok('K'), status: 'ACTIVE', walletId: null, stockedAt: null });
    await expect(svc.stock(SALA, recepcion, { card: tok('J') })).resolves.toMatchObject({ outcome: 'returned' });
    expect(cards.get('vieja-dada')).toMatchObject({ status: 'RETURNED', walletId: null });
    await expect(svc.stock(SALA, recepcion, { card: tok('K') })).resolves.toEqual({ outcome: 'stocked' });
    expect(cards.get('vieja-libre')).toMatchObject({ status: 'STOCK', stockedAt: NOW });
    expect(events.map((e) => [e.cardId, e.kind])).toEqual([['vieja-dada', 'RETURNED']]);
  });

  it('una del stock de otro local del grupo pasa al stock de este', async () => {
    const { svc, put, cards } = setup();
    put({ id: 'norte', token: tok('H'), venueId: NORTE });
    await expect(svc.stock(SALA, recepcion, { card: tok('H') })).resolves.toEqual({ outcome: 'already' });
    expect(cards.get('norte')).toMatchObject({ venueId: SALA, status: 'STOCK' });
  });

  it('con las fichas NFC apagadas en Ajustes: 409', async () => {
    const { svc } = setup({ nfc: false });
    await expect(svc.newStockToken(SALA, recepcion)).rejects.toMatchObject({ status: 409 });
    await expect(svc.stock(SALA, recepcion, { card: tok('A') })).rejects.toMatchObject({ status: 409 });
  });
});

describe('panel: Clientes → Fichas', () => {
  it('la lista es la del local, sin los códigos sin grabar; busca por número de serie, código del saldo o el grabado', async () => {
    const { svc, tx } = setup();
    await svc.list(SALA, { q: '04:a2:3b', status: 'ISSUED' });
    const where = (tx.walletCard.findMany.mock.calls[0] as unknown as [{ where: Row }])[0].where;
    expect(where).toMatchObject({ venueId: SALA, NOT: { status: 'STOCK', stockedAt: null } });
    const [byStatus, bySearch] = where.AND as [Row, Row];
    // Entregadas: ISSUED y, del API anterior, ACTIVE con saldo.
    expect(byStatus).toEqual({ status: { in: ['ISSUED', 'ACTIVE'] }, walletId: { not: null } });
    expect(bySearch.OR).toEqual(expect.arrayContaining([{ uid: { contains: '04A23B' } }, { token: { startsWith: '04:a2:3b' } }]));
    await svc.list(SALA, { q: 'k7q-4m2', status: 'raro' });
    const byCode = (tx.walletCard.findMany.mock.calls[1] as unknown as [{ where: Row }])[0].where;
    expect(byCode).not.toHaveProperty('status');
    expect((byCode.AND as Row[])[1]!.OR).toEqual(expect.arrayContaining([{ walletId: { in: [W_CON] } }]));
  });

  it('en la lista, el código grabado no sale entero y el del saldo solo si está entregada', () => {
    const base = {
      id: 'c', uid: null, token: 'q3VbX9kLmN2pR7sT4wYz1A', stockedAt: NOW, linkedAt: null, returnedAt: null, lostAt: null,
      blockedAt: null, lastUsedAt: null, wallet: { shortCode: 'K7Q4M2' },
    };
    expect(cardRow({ ...base, status: 'ISSUED' })).toMatchObject({ tokenHint: 'q3VbX9', walletCode: 'K7Q-4M2', status: 'ISSUED' });
    expect(cardRow({ ...base, status: 'BLOCKED' })).toMatchObject({ walletCode: null, stockedAt: NOW.toISOString() });
    expect(cardRow({ ...base, status: 'ACTIVE' }).status).toBe('STOCK');
  });

  it('bloquear o marcar perdida: el encargado de su local; una ya perdida o bloqueada → 409', async () => {
    const { svc, put, cards, audit, events } = setup();
    put({ id: 'card-1', token: tok('A'), walletId: W_CON, status: 'ISSUED' });
    put({ id: 'card-2', token: tok('B') });
    await expect(svc.mark(javi, 'card-1', 'lost')).resolves.toMatchObject({ id: 'card-1', status: 'LOST', lostAt: NOW.toISOString() });
    expect(cards.get('card-1')).toMatchObject({ status: 'LOST', walletId: W_CON });
    await expect(svc.mark(javi, 'card-1', 'block')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.mark(javi, 'card-2', 'block')).resolves.toMatchObject({ status: 'BLOCKED' });
    await expect(svc.mark(javi, 'card-2', 'lost')).rejects.toThrow(/bloqueada/);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.card_lost', actorId: JAVI, targetId: 'card-1' }));
    // Cada cambio deja su evento, con el local y quién (los contadores de la noche cuentan eventos).
    expect(events.map((e) => [e.cardId, e.kind, e.venueId, e.byUserId])).toEqual([
      ['card-1', 'LOST', SALA, JAVI],
      ['card-2', 'BLOCKED', SALA, JAVI],
    ]);
  });

  it('la chica no; el encargado de otro grupo no la ve', async () => {
    const { svc, put } = setup();
    put({ id: 'card-1', token: tok('A'), venueId: SALA });
    await expect(svc.mark({ ...javi, role: 'OPERATOR' as never }, 'card-1', 'block')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.mark({ ...javi, tenantId: NEON }, 'card-1', 'block')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.mark(javi, 'no-existe', 'block')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resumen: las noches cerradas con lo congelado en su Z; la abierta, en vivo; las de antes de las fichas, sin stock', async () => {
    const { svc, tx } = setup();
    tx.walletCard.count.mockResolvedValueOnce(12).mockResolvedValueOnce(5);
    const opened = new Date(NOW.getTime() - 3 * 3600_000);
    tx.venueNight.findMany.mockResolvedValueOnce([
      { id: 'n-abierta', openedAt: opened, closedAt: null, zReport: null },
      { id: 'n-ayer', openedAt: new Date(NOW.getTime() - 26 * 3600_000), closedAt: new Date(NOW.getTime() - 19 * 3600_000), zReport: { fichas: { entregadas: 7, devueltas: 6, perdidas: 1, enStock: 14 } } },
      { id: 'n-vieja', openedAt: new Date(NOW.getTime() - 50 * 3600_000), closedAt: new Date(NOW.getTime() - 43 * 3600_000), zReport: { summary: {} } },
    ]);
    tx.$queryRaw.mockResolvedValue([{ entregadas: 3, devueltas: 1, perdidas: 0, enStock: 12 }]);
    const s = await svc.summary(SALA, NOW);
    expect(s.enStock).toBe(12);
    expect(s.entregadas).toBe(5);
    expect(s.nights).toEqual([
      { nightId: 'n-abierta', from: opened.toISOString(), to: null, open: true, entregadas: 3, devueltas: 1, perdidas: 0, enStock: 12 },
      expect.objectContaining({ nightId: 'n-ayer', open: false, entregadas: 7, devueltas: 6, perdidas: 1, enStock: 14 }),
      expect.objectContaining({ nightId: 'n-vieja', entregadas: 3, enStock: null }),
    ]);
  });
});

describe('fichas congeladas en el Z', () => {
  it('solo un bloque completo de números', () => {
    expect(frozenFichas({ fichas: { entregadas: 1, devueltas: 2, perdidas: 0, enStock: 9 } })).toEqual({
      entregadas: 1, devueltas: 2, perdidas: 0, enStock: 9,
    });
    expect(frozenFichas({ fichas: { entregadas: 1, devueltas: 2, perdidas: 0 } })).toBeNull();
    expect(frozenFichas({ fichas: { entregadas: '1', devueltas: 2, perdidas: 0, enStock: 9 } })).toBeNull();
    expect(frozenFichas(null)).toBeNull();
    expect(frozenFichas({})).toBeNull();
  });
});
