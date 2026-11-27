import { DEMO_FIXTURES, FIXTURES, type FixtureName } from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { testHelpersOn } from '../../../config/partner-test-mode';
import { insertEmptyWallet } from '../../wallets/empty-wallet';
import { partnerApiEnabled, partnerApiMode } from '../partner-flag';

/**
 * Las fichas de prueba de la demo (PR 8 parte A; decisión 17 del contrato):
 * dos sociedades y tres locales inventados, las 9 fichas del contrato
 * (DEMO_FIXTURES) y, para la prueba de carga, fichas `demo-carga-…`. Solo lo
 * escriben la semilla (scripts/partner-demo-seed.ts) y el reinicio
 * (`POST /test/fixtures/reset`). Nunca borra nada: un reinicio da a cada ficha
 * un saldo nuevo; los viejos guardan sus cargas (siguen en las listas y en el
 * tope de la noche de la conexión) y salen de los topes de las fichas.
 */

type DemoTx = Pick<Prisma.TransactionClient, 'business' | 'venue' | 'clientWallet' | 'walletCard' | '$queryRaw'>;

export const DEMO_BUSINESSES = {
  main: { name: 'Empresa Demo S.L.', taxId: 'B00000000' },
  other: { name: 'Otra Empresa Demo S.L.', taxId: 'B00000001' },
} as const;

type DemoBusiness = keyof typeof DEMO_BUSINESSES;

export const DEMO_VENUES = {
  centro: { slug: 'demo-centro', name: 'Local Demo Centro', business: 'main', walletGroup: 'demo-grupo' },
  otraSociedad: { slug: 'demo-otra-sociedad', name: 'Local Demo Otra Sociedad', business: 'other', walletGroup: 'demo-grupo' },
  otroGrupo: { slug: 'demo-otro-grupo', name: 'Local Demo Otro Grupo', business: 'main', walletGroup: 'demo-otro-grupo' },
} as const satisfies Record<string, { slug: string; name: string; business: DemoBusiness; walletGroup: string }>;

type DemoVenue = keyof typeof DEMO_VENUES;

const BLOCKED_REASON = 'Ficha de prueba de la demo';
export const DEMO_CARGA_PREFIX = 'demo-carga-';
export const DEMO_CARGA_DEFAULT = 300;
export const DEMO_CARGA_MAX = 500;

/** Dónde vive cada ficha y en qué estado queda (además de DEMO_FIXTURES). */
const FIXTURE_STATE: Readonly<
  Record<FixtureName, { venue: DemoVenue; card: 'ISSUED' | 'LOST' | 'BLOCKED'; wallet: 'ACTIVE' | 'DEPLETED' | 'EXPIRED'; blocked?: true }>
> = {
  active: { venue: 'centro', card: 'ISSUED', wallet: 'ACTIVE' },
  empty: { venue: 'centro', card: 'ISSUED', wallet: 'DEPLETED' },
  ficha_uid: { venue: 'centro', card: 'ISSUED', wallet: 'ACTIVE' },
  blocked: { venue: 'centro', card: 'ISSUED', wallet: 'ACTIVE', blocked: true },
  closed: { venue: 'centro', card: 'ISSUED', wallet: 'EXPIRED' },
  lost_ficha: { venue: 'centro', card: 'LOST', wallet: 'ACTIVE' },
  ficha_blocked: { venue: 'centro', card: 'BLOCKED', wallet: 'ACTIVE' },
  other_group: { venue: 'otroGrupo', card: 'ISSUED', wallet: 'ACTIVE' },
  other_company: { venue: 'otraSociedad', card: 'ISSUED', wallet: 'ACTIVE' },
};

/** Sin semilla: los locales de la demo no están. */
export class DemoFixturesMissingError extends Error {
  constructor() {
    super('Faltan las fichas de prueba: corre partner-demo-seed');
    this.name = 'DemoFixturesMissingError';
  }
}

/** Otro reinicio tiene el candado: este no espera (429 al momento). */
export class DemoResetBusyError extends Error {
  constructor() {
    super('Otro reinicio de las fichas de prueba está en marcha');
    this.name = 'DemoResetBusyError';
  }
}

/**
 * Las 9 fichas como al principio, de una en una y en una transacción (con su
 * candado, sin esperarlo: si otro reinicio lo tiene, DemoResetBusyError). Por ficha, un saldo
 * nuevo vacío (`insertEmptyWallet`, que reintenta el código corto) al que se
 * pone su saldo y su estado (se fija, nunca se resta), y la ficha por su `token`
 * apuntando a él. Lee los 3 locales y escribe solo esas 9 fichas y sus saldos
 * nuevos. Devuelve los saldos anteriores (para anular sus códigos del móvil).
 */
export async function resetDemoFixtures(tx: DemoTx): Promise<string[]> {
  // Sin esperar: varios reinicios a la vez no ocupan conexiones de la base esperando el candado.
  const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended('partner-demo-reset', 0)) AS ok`;
  if (!lock?.ok) throw new DemoResetBusyError();
  const venues = await demoVenues(tx);
  const tokens = FIXTURES.map((f) => DEMO_FIXTURES[f].token);
  const before = await tx.walletCard.findMany({ where: { token: { in: tokens } }, select: { walletId: true } });
  const now = new Date();
  for (const fixture of FIXTURES) {
    const def = DEMO_FIXTURES[fixture];
    const state = FIXTURE_STATE[fixture];
    const venue = venues[state.venue];
    const walletId = await insertEmptyWallet(tx, venue.id, { identifier: null, walletGroup: venue.walletGroup });
    await tx.clientWallet.update({
      where: { id: walletId },
      data: {
        balanceCents: def.balanceCents,
        status: state.wallet,
        blockedAt: state.blocked ? now : null,
        blockedReason: state.blocked ? BLOCKED_REASON : null,
      },
    });
    const card = {
      uid: def.uid,
      status: state.card,
      walletId,
      venueId: venue.id,
      linkedAt: now,
      returnedAt: null,
      lostAt: state.card === 'LOST' ? now : null,
      blockedAt: state.card === 'BLOCKED' ? now : null,
    };
    await tx.walletCard.upsert({ where: { token: def.token }, update: card, create: { token: def.token, ...card } });
  }
  return before.flatMap((c) => (c.walletId ? [c.walletId] : []));
}

async function demoVenues(tx: DemoTx): Promise<Record<DemoVenue, { id: string; walletGroup: string | null }>> {
  const slugs = Object.values(DEMO_VENUES).map((v) => v.slug);
  const rows = await tx.venue.findMany({ where: { slug: { in: slugs }, deletedAt: null }, select: { id: true, slug: true, walletGroup: true } });
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const out = {} as Record<DemoVenue, { id: string; walletGroup: string | null }>;
  for (const [key, v] of Object.entries(DEMO_VENUES) as Array<[DemoVenue, (typeof DEMO_VENUES)[DemoVenue]]>) {
    const row = bySlug.get(v.slug);
    if (!row) throw new DemoFixturesMissingError();
    out[key] = { id: row.id, walletGroup: row.walletGroup };
  }
  return out;
}

export interface DemoSeedCounts {
  sociedades: number;
  locales: number;
  fichas: number;
  carga: number;
}

/**
 * La semilla entera: sociedades por `taxId`, locales por `slug` (con su
 * sociedad y su grupo; solo aquí se escribe `demo-otra-sociedad` en el grupo
 * de otra sociedad, que la consola rechaza con assertWalletGroupInBusiness),
 * el reinicio de las 9 fichas y `carga` fichas `demo-carga-000001…` (Centro,
 * saldo vacío, solo las que faltan; el reinicio no las toca). Repetirla da los
 * mismos recuentos.
 */
export async function seedPartnerDemo(tx: DemoTx, opts: { carga: number }): Promise<DemoSeedCounts> {
  const businessIds = {} as Record<DemoBusiness, string>;
  for (const [key, b] of Object.entries(DEMO_BUSINESSES) as Array<[DemoBusiness, (typeof DEMO_BUSINESSES)[DemoBusiness]]>) {
    const row = await tx.business.upsert({ where: { taxId: b.taxId }, update: { name: b.name }, create: { name: b.name, taxId: b.taxId }, select: { id: true } });
    businessIds[key] = row.id;
  }
  for (const v of Object.values(DEMO_VENUES)) {
    const data = { name: v.name, walletGroup: v.walletGroup, businessId: businessIds[v.business] };
    await tx.venue.upsert({ where: { slug: v.slug }, update: data, create: { slug: v.slug, ...data }, select: { id: true } });
  }
  await resetDemoFixtures(tx);
  const centro = (await demoVenues(tx)).centro;
  const wanted = Array.from({ length: opts.carga }, (_, i) => `${DEMO_CARGA_PREFIX}${String(i + 1).padStart(6, '0')}`);
  const existing = new Set(
    (await tx.walletCard.findMany({ where: { token: { in: wanted } }, select: { token: true } })).map((c) => c.token),
  );
  const now = new Date();
  for (const token of wanted) {
    if (existing.has(token)) continue;
    const walletId = await insertEmptyWallet(tx, centro.id, { identifier: null, walletGroup: centro.walletGroup });
    await tx.clientWallet.update({ where: { id: walletId }, data: { status: 'DEPLETED' } });
    await tx.walletCard.create({ data: { token, status: 'ISSUED', walletId, venueId: centro.id, linkedAt: now } });
  }
  const carga = await tx.walletCard.count({ where: { token: { startsWith: DEMO_CARGA_PREFIX } } });
  return { sociedades: Object.keys(DEMO_BUSINESSES).length, locales: Object.keys(DEMO_VENUES).length, fichas: FIXTURES.length, carga };
}

type RawEnv = Readonly<Record<string, string | undefined>>;

export type DemoSeedOptions = { ok: true; carga: number } | { ok: false; reason: string };

/** Las opciones de la semilla, o por qué se niega. Pura: no abre la base. */
export function demoSeedOptions(env: RawEnv, argv: readonly string[]): DemoSeedOptions {
  if (!(partnerApiEnabled(env) && partnerApiMode(env) === 'test')) {
    return { ok: false, reason: 'La semilla de la demo solo va con la API en test: PARTNER_API_ENABLED=true y PARTNER_API_MODE=test.' };
  }
  if (!testHelpersOn(env)) return { ok: false, reason: 'La semilla de la demo solo va con las ayudas de prueba: PARTNER_TEST_HELPERS=1.' };
  const at = argv.findIndex((a) => a === '--carga' || a.startsWith('--carga='));
  if (at < 0) return { ok: true, carga: DEMO_CARGA_DEFAULT };
  const raw = argv[at]!.startsWith('--carga=') ? argv[at]!.slice('--carga='.length) : argv[at + 1];
  if (raw === undefined || !/^\d{1,3}$/.test(raw) || Number(raw) > DEMO_CARGA_MAX) {
    return { ok: false, reason: `--carga es un número de 0 a ${DEMO_CARGA_MAX}.` };
  }
  return { ok: true, carga: Number(raw) };
}
