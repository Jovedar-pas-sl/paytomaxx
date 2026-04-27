#!/usr/bin/env tsx
/**
 * NightPay CLI — gestion de venues y usuarios (uso interno, solo local).
 *
 * Uso:
 *   pnpm cli create-venue --name "Luna VLC" --slug luna-vlc [--timezone Europe/Madrid]
 *   pnpm cli create-manager --venue luna-vlc --email alice@nightpay.local --password "..."
 *   pnpm cli create-owner   --venue luna-vlc --email owner@nightpay.local --password "..."
 *   pnpm cli list-venues
 *   pnpm cli list-users --venue luna-vlc
 *   pnpm cli create-terminal --venue luna-vlc --external-id BARRA-1 --label "Barra 1"
 *   pnpm cli reset-password --email alice@nightpay.local --password "..."
 *
 * Todas las operaciones corren con RLS bypass (app.bypass_rls=on) por ser herramientas
 * de sistema operadas solo por el OWNER humano desde la terminal.
 */

import * as bcrypt from 'bcryptjs';
import { PrismaClient, Prisma, Role } from '../src/generated/client';

const prisma = new PrismaClient();

type Args = Record<string, string | boolean>;

// Cliente transaccional que SI hereda el SET LOCAL del bypass.
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$use' | '$transaction' | '$extends'>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function must(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing --${key}`);
  }
  return v;
}

/**
 * Ejecuta `fn` dentro de una transaccion con `app.bypass_rls=on`.
 * IMPORTANTE: `fn` recibe `tx` y debe usarlo para todas las queries —
 * usar el cliente externo `prisma` sale de la transaccion y pierde el bypass.
 */
async function withBypass<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    return fn(tx);
  });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ---- commands ----

async function cmdCreateVenue(args: Args) {
  const name = must(args, 'name');
  const slug = (args.slug as string) || slugify(name);
  const timezone = (args.timezone as string) || 'Europe/Madrid';

  const venue = await withBypass((tx) =>
    tx.venue.upsert({
      where: { slug },
      update: {},
      create: { name, slug, timezone },
    }),
  );

  console.log(`[ok] venue: ${venue.name} (slug=${venue.slug} id=${venue.id})`);
  return venue;
}

async function cmdCreateUser(args: Args, role: Role) {
  const venueSlug = must(args, 'venue');
  const email = must(args, 'email').toLowerCase();
  const password = must(args, 'password');

  if (password.length < 8) throw new Error('password must be >= 8 chars');

  const hash = await bcrypt.hash(password, 10);

  const user = await withBypass(async (tx) => {
    const venue = await tx.venue.findUnique({ where: { slug: venueSlug } });
    if (!venue) throw new Error(`venue not found: ${venueSlug}`);
    return tx.user.upsert({
      where: { email },
      update: { passwordHash: hash, role, tenantId: venue.id, deletedAt: null },
      create: { email, passwordHash: hash, role, tenantId: venue.id },
    });
  });

  console.log(`[ok] ${role.toLowerCase()}: ${user.email} -> venue ${venueSlug} (id=${user.id})`);
  return user;
}

async function cmdCreateTerminal(args: Args) {
  const venueSlug = must(args, 'venue');
  const externalId = must(args, 'external-id');
  const label = (args.label as string) || externalId;

  const terminal = await withBypass(async (tx) => {
    const venue = await tx.venue.findUnique({ where: { slug: venueSlug } });
    if (!venue) throw new Error(`venue not found: ${venueSlug}`);
    return tx.terminal.upsert({
      where: { tenantId_externalId: { tenantId: venue.id, externalId } },
      update: { label, active: true },
      create: { tenantId: venue.id, externalId, label },
    });
  });

  console.log(`[ok] terminal: ${terminal.label} (${terminal.externalId}) -> venue ${venueSlug}`);
  return terminal;
}

async function cmdResetPassword(args: Args) {
  const email = must(args, 'email').toLowerCase();
  const password = must(args, 'password');
  if (password.length < 8) throw new Error('password must be >= 8 chars');

  const hash = await bcrypt.hash(password, 10);
  const user = await withBypass((tx) =>
    tx.user.update({ where: { email }, data: { passwordHash: hash } }),
  );
  console.log(`[ok] password reset: ${user.email}`);
}

async function cmdListVenues() {
  const venues = await withBypass((tx) =>
    tx.venue.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { users: true, terminals: true, payments: true } } },
    }),
  );

  if (venues.length === 0) {
    console.log('(no venues)');
    return;
  }

  console.log('\nVenues:');
  for (const v of venues) {
    console.log(
      `  - ${v.slug.padEnd(20)} ${v.name.padEnd(30)} users=${v._count.users} terminals=${v._count.terminals} payments=${v._count.payments}`,
    );
  }
}

async function cmdListUsers(args: Args) {
  const venueSlug = args.venue as string | undefined;

  const where: Prisma.UserWhereInput = venueSlug
    ? { venue: { slug: venueSlug }, deletedAt: null }
    : { deletedAt: null };

  const users = await withBypass((tx) =>
    tx.user.findMany({
      where,
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
      include: { venue: { select: { slug: true } } },
    }),
  );

  if (users.length === 0) {
    console.log('(no users)');
    return;
  }

  console.log('\nUsers:');
  for (const u of users) {
    console.log(`  - ${u.email.padEnd(40)} ${u.role.padEnd(8)} venue=${u.venue.slug}`);
  }
}

// ---- dispatcher ----

const commands: Record<string, (args: Args) => Promise<unknown>> = {
  'create-venue': cmdCreateVenue,
  'create-owner': (args) => cmdCreateUser(args, Role.OWNER),
  'create-manager': (args) => cmdCreateUser(args, Role.MANAGER),
  'create-waiter': (args) => cmdCreateUser(args, Role.WAITER),
  'create-terminal': cmdCreateTerminal,
  'reset-password': cmdResetPassword,
  'list-venues': cmdListVenues,
  'list-users': cmdListUsers,
};

function printUsage(): void {
  console.log('NightPay CLI — uso:');
  console.log('');
  console.log('  pnpm cli create-venue    --name "Luna VLC" [--slug luna-vlc] [--timezone Europe/Madrid]');
  console.log('  pnpm cli create-owner    --venue <slug> --email <email> --password <pwd>');
  console.log('  pnpm cli create-manager  --venue <slug> --email <email> --password <pwd>');
  console.log('  pnpm cli create-waiter   --venue <slug> --email <email> --password <pwd>');
  console.log('  pnpm cli create-terminal --venue <slug> --external-id BARRA-1 [--label "Barra 1"]');
  console.log('  pnpm cli reset-password  --email <email> --password <new>');
  console.log('  pnpm cli list-venues');
  console.log('  pnpm cli list-users      [--venue <slug>]');
  console.log('');
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    printUsage();
    process.exit(1);
  }

  const args = parseArgs(rest);
  await handler(args);
}

main()
  .catch((err) => {
    console.error(`[error] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
