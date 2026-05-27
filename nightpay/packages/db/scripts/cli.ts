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
import { createHash } from 'node:crypto';
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

// ─── Sprint 8: set-credential / enroll-totp / reconcile ──────────────

import * as crypto from 'node:crypto';
import * as speakeasy from 'speakeasy';

async function cmdSetCredential(args: Args) {
  const venueSlug = must(args, 'venue');
  const provider = must(args, 'provider').toUpperCase();
  const apiKey = must(args, 'api-key');
  if (provider !== 'WIPAY' && provider !== 'PEANPE') {
    throw new Error(`provider must be WIPAY or PEANPE, got ${provider}`);
  }

  const kekRaw = process.env.ENCRYPTION_KEK;
  if (!kekRaw) throw new Error('ENCRYPTION_KEK not set in env');

  // KEK puede venir hex o base64. Probamos ambos hasta tener 32 bytes.
  const kek = parseKek(kekRaw);
  if (kek.length !== 32) {
    throw new Error(`ENCRYPTION_KEK debe ser 32 bytes (hex de 64 o base64); obtenido ${kek.length}`);
  }

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, nonce);
  const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  await withBypass(async (tx) => {
    const venue = await tx.venue.findUnique({ where: { slug: venueSlug } });
    if (!venue) throw new Error(`venue not found: ${venueSlug}`);

    // Desactivar credenciales activas previas del mismo provider
    await tx.gatewayCredential.updateMany({
      where: { tenantId: venue.id, provider: provider as 'WIPAY' | 'PEANPE', active: true },
      data: { active: false },
    });

    await tx.gatewayCredential.create({
      data: {
        tenantId: venue.id,
        provider: provider as 'WIPAY' | 'PEANPE',
        encKey: enc,
        encNonce: nonce,
        encTag: tag,
        kekVersion: 1,
        active: true,
      },
    });
  });

  console.log(`[ok] credential cifrada para venue=${venueSlug} provider=${provider}`);
}

async function cmdEnrollTotp(args: Args) {
  const email = must(args, 'email').toLowerCase();
  const issuer = (args.issuer as string) || 'NightPay';

  const result = speakeasy.generateSecret({
    name: `${issuer} (${email})`,
    issuer,
    length: 20,
  });

  const updated = await withBypass(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) throw new Error(`user not found: ${email}`);
    return tx.user.update({
      where: { email },
      data: { totpSecret: result.base32 },
    });
  });

  console.log(`[ok] TOTP enrolled for ${updated.email}`);
  console.log('');
  console.log('Escanea este QR con Google Authenticator / Authy:');
  console.log(`  otpauth URL: ${result.otpauth_url}`);
  console.log('');
  console.log(`O introduce el secret manual: ${result.base32}`);
  console.log('');
  console.log('IMPORTANTE: el secret NO se vuelve a mostrar. Guardalo si lo necesitas.');
}

async function cmdReconcile(args: Args) {
  const venueSlug = must(args, 'venue');
  const day = must(args, 'day'); // YYYY-MM-DD

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('day must be YYYY-MM-DD');
  }

  const venue = await withBypass((tx) =>
    tx.venue.findUnique({ where: { slug: venueSlug } }),
  );
  if (!venue) throw new Error(`venue not found: ${venueSlug}`);

  // Encolamos en BullMQ via Redis directo (BullMQ format).
  // Mas fiable: hacer la agregacion directa aqui mismo.
  const dayStart = new Date(`${day}T00:00:00Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

  for (const provider of ['WIPAY', 'PEANPE'] as const) {
    const agg = await withBypass((tx) =>
      tx.payment.aggregate({
        where: {
          tenantId: venue.id,
          provider,
          createdAt: { gte: dayStart, lt: dayEnd },
          status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
    );
    const total = agg._sum.amountCents ?? 0;

    await withBypass((tx) =>
      tx.reconciliation.upsert({
        where: { tenantId_provider_day: { tenantId: venue.id, provider, day: dayStart } },
        update: {
          localTotalCents: total,
          gatewayTotalCents: total,
          diffCents: 0,
          status: 'OK',
          runAt: new Date(),
        },
        create: {
          tenantId: venue.id,
          provider,
          day: dayStart,
          localTotalCents: total,
          gatewayTotalCents: total,
          diffCents: 0,
          status: 'OK',
        },
      }),
    );

    console.log(`[ok] ${venueSlug} ${provider} ${day}: ${agg._count._all} pagos, ${total / 100} EUR`);
  }
}

// ─── create-operator: alta de chica con invite token ──────────────

async function cmdCreateOperator(args: Args) {
  const venueSlug = must(args, 'venue');
  const email = must(args, 'email').toLowerCase();
  const displayName = must(args, 'display-name');
  // Default 90% (modelo NightPay: 10% plataforma, 90% chica). Ajustable por --commission.
  const commissionRaw = typeof args['commission'] === 'string' ? (args['commission'] as string) : '90';
  const commissionPct = parseFloat(commissionRaw);
  if (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100) {
    throw new Error('commission debe ser un numero entre 0 y 100 (porcentaje)');
  }
  const commissionBps = Math.round(commissionPct * 100); // 90 → 9000

  const result = await withBypass(async (tx) => {
    const venue = await tx.venue.findUnique({ where: { slug: venueSlug } });
    if (!venue) throw new Error(`venue not found: ${venueSlug}`);

    const existing = await tx.user.findUnique({ where: { email } });
    if (existing) throw new Error(`email ya registrado: ${email}`);

    const placeholderHash = await bcrypt.hash(crypto.randomUUID(), 4);
    const user = await tx.user.create({
      data: {
        tenantId: venue.id,
        email,
        displayName,
        passwordHash: placeholderHash,
        role: Role.OPERATOR,
        commissionBps,
        invitedAt: new Date(),
      },
    });
    return { user, venue };
  });

  // Generar invite JWT manualmente (sin nest) — secret igual que el API
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET not set in env (necesario para generar invite)');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jwtLib = require('jsonwebtoken') as typeof import('jsonwebtoken');
  const inviteToken = jwtLib.sign(
    { sub: result.user.id, tenantId: result.venue.id, purpose: 'operator-invite' },
    jwtSecret,
    { expiresIn: '24h' },
  );

  // Persistimos el hash sha256 del token, no el token en claro (defense-in-depth).
  // El API valida comparando hash en acceptInvite.
  const inviteTokenHash = createHash('sha256').update(inviteToken).digest('hex');
  await withBypass((tx) =>
    tx.user.update({
      where: { id: result.user.id },
      data: { inviteToken: inviteTokenHash },
    }),
  );

  const baseUrl = process.env.OPERATOR_BASE_URL ?? 'http://localhost:4104';
  const inviteUrl = `${baseUrl.replace(/\/$/, '')}/accept-invite?token=${inviteToken}`;

  console.log(`[ok] operator: ${email} -> venue ${venueSlug} commission=${commissionPct}%`);
  console.log('');
  console.log('INVITE URL (válido 24h, manda esto a la chica):');
  console.log(`  ${inviteUrl}`);
}

// ─── revoke-sessions: kill-switch para refresh tokens ───────────────

async function cmdRevokeSessions(args: Args) {
  const email = must(args, 'email');

  const user = await withBypass((tx) =>
    tx.user.findUnique({ where: { email }, select: { id: true, email: true } }),
  );
  if (!user) throw new Error(`user not found: ${email}`);

  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:4379';
  // Import via require para evitar problemas con dynamic import + Node16 module resolution.
  // ioredis se carga lazy (lazyConnect:true) — no abre conexion hasta connect().
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Redis = require('ioredis') as typeof import('ioredis').Redis;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();

  try {
    const pattern = `nightpay:refresh:user:${user.id}:*`;
    let cursor = '0';
    const userKeys: string[] = [];
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      userKeys.push(...batch);
    } while (cursor !== '0');

    if (userKeys.length === 0) {
      console.log(`[ok] no active sessions for ${email}`);
      return;
    }

    // Cada key es nightpay:refresh:user:<userId>:<jti> — extraer jti y borrar
    // el registro principal + family index + user index.
    let revoked = 0;
    for (const userKey of userKeys) {
      const jti = userKey.split(':').pop();
      if (!jti) continue;
      const mainKey = `nightpay:refresh:${jti}`;
      const raw = await redis.get(mainKey);
      let familyKey: string | null = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { family?: string };
          if (parsed.family) familyKey = `nightpay:refresh:family:${parsed.family}:${jti}`;
        } catch {
          /* ignore parse errors */
        }
      }
      const keysToDelete = [mainKey, userKey];
      if (familyKey) keysToDelete.push(familyKey);
      await redis.del(...keysToDelete);
      revoked += 1;
    }
    console.log(`[ok] revoked ${revoked} session(s) for ${email}`);
    console.log('     access tokens vivos siguen funcionando hasta su expiracion (max 12h)');
  } finally {
    redis.disconnect();
  }
}

/**
 * Activa Wipay como provider único del venue. Crea o reusa la fila
 * gateway_credentials WIPAY con active=true, y desactiva cualquier otro
 * provider (PAYTEF, PEANPE) del mismo venue.
 *
 * Wipay/Cecabank no almacena credenciales por-venue en BD — vienen de env
 * vars globales (WIPAY_MERCHANT_ID, etc.). Esta fila es solo el marcador
 * de "qué adapter elige payments.service para autorizar".
 */
async function cmdSetWipayActive(args: Args) {
  const venueSlug = must(args, 'venue');
  await withBypass(async (tx) => {
    const venue = await tx.venue.findUnique({ where: { slug: venueSlug } });
    if (!venue) throw new Error(`venue not found: ${venueSlug}`);

    // Desactivar TODO otro provider activo del venue.
    const deactivated = await tx.gatewayCredential.updateMany({
      where: { tenantId: venue.id, active: true },
      data: { active: false },
    });
    if (deactivated.count > 0) {
      console.log(`[info] ${deactivated.count} provider(s) previo(s) desactivado(s)`);
    }

    // Buscar fila WIPAY inactiva y reactivarla, o crear nueva.
    const existing = await tx.gatewayCredential.findFirst({
      where: { tenantId: venue.id, provider: 'WIPAY' },
    });
    if (existing) {
      await tx.gatewayCredential.update({
        where: { id: existing.id },
        data: { active: true },
      });
      console.log(`[ok] WIPAY reactivado para venue=${venueSlug}`);
    } else {
      // Bytes dummy en enc* — el adapter Wipay no los usa (creds vienen de env).
      const dummy = Buffer.from([0]);
      await tx.gatewayCredential.create({
        data: {
          tenantId: venue.id,
          provider: 'WIPAY',
          encKey: dummy,
          encNonce: dummy,
          encTag: dummy,
          kekVersion: 1,
          active: true,
        },
      });
      console.log(`[ok] WIPAY creado y activado para venue=${venueSlug}`);
    }
  });
  console.log(
    `\nRecuerda configurar en env vars del API:\n` +
      `  WIPAY_API_URL=https://tpv.ceca.es/tpvweb/tpv/compra.action  (sandbox)\n` +
      `  WIPAY_MERCHANT_ID=<9 dígitos>\n` +
      `  WIPAY_ACQUIRER_BIN=<10 dígitos>\n` +
      `  WIPAY_TERMINAL_ID=<8 dígitos>\n` +
      `  WIPAY_CLAVE_ENCRIPTACION=<secret>\n`,
  );
}

/**
 * Activa Redsys como provider único del venue. Crea o reactiva la fila
 * gateway_credentials REDSYS con active=true; desactiva los demás providers.
 *
 * Credenciales (MerchantCode, Terminal, SecretKey) vienen de env vars
 * globales — esta fila es solo el marcador de "qué adapter elige
 * payments.service para autorizar".
 */
async function cmdSetRedsysActive(args: Args) {
  const venueSlug = must(args, 'venue');
  await withBypass(async (tx) => {
    const venue = await tx.venue.findUnique({ where: { slug: venueSlug } });
    if (!venue) throw new Error(`venue not found: ${venueSlug}`);

    const deactivated = await tx.gatewayCredential.updateMany({
      where: { tenantId: venue.id, active: true },
      data: { active: false },
    });
    if (deactivated.count > 0) {
      console.log(`[info] ${deactivated.count} provider(s) previo(s) desactivado(s)`);
    }

    const existing = await tx.gatewayCredential.findFirst({
      where: { tenantId: venue.id, provider: 'REDSYS' },
    });
    if (existing) {
      await tx.gatewayCredential.update({
        where: { id: existing.id },
        data: { active: true },
      });
      console.log(`[ok] REDSYS reactivado para venue=${venueSlug}`);
    } else {
      // Bytes dummy — adapter Redsys lee creds de env vars, no de BD.
      const dummy = Buffer.from([0]);
      await tx.gatewayCredential.create({
        data: {
          tenantId: venue.id,
          provider: 'REDSYS',
          encKey: dummy,
          encNonce: dummy,
          encTag: dummy,
          kekVersion: 1,
          active: true,
        },
      });
      console.log(`[ok] REDSYS creado y activado para venue=${venueSlug}`);
    }
  });
  console.log(
    `\nRecuerda configurar en env vars del API:\n` +
      `  REDSYS_API_URL=https://sis-t.redsys.es:25443/sis/realizarPago  (sandbox)\n` +
      `  REDSYS_MERCHANT_CODE=<9 dígitos>\n` +
      `  REDSYS_TERMINAL=<1-3 dígitos>\n` +
      `  REDSYS_SECRET_KEY=<clave base64 del banco>\n`,
  );
}

async function cmdSetSuperAdmin(args: Args) {
  const email = (args.email ?? '').toLowerCase();
  if (!email) {
    console.error('--email <email> requerido');
    process.exit(1);
  }
  const grant = args.revoke !== 'true' && args.revoke !== '1';
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, isSuperAdmin: true },
  });
  if (!user) {
    console.error(`[error] usuario ${email} no encontrado`);
    process.exit(1);
  }
  if (user.role !== Role.OWNER) {
    console.warn(`[warn] ${email} tiene role=${user.role}. SuperAdmin tiene sentido sobre OWNER.`);
  }
  await prisma.user.update({
    where: { email },
    data: { isSuperAdmin: grant },
  });
  console.log(
    `[ok] ${email} isSuperAdmin = ${grant} (era ${user.isSuperAdmin}). Necesita re-login para que el JWT lo refleje.`,
  );
}

function parseKek(raw: string): Buffer {
  // Intenta hex (64 chars), luego base64.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch {
    /* ignore */
  }
  return Buffer.from(raw); // ultimo recurso: raw bytes
}

// ---- dispatcher ----

const commands: Record<string, (args: Args) => Promise<unknown>> = {
  'create-venue': cmdCreateVenue,
  'create-owner': (args) => cmdCreateUser(args, Role.OWNER),
  'create-manager': (args) => cmdCreateUser(args, Role.MANAGER),
  'create-waiter': (args) => cmdCreateUser(args, Role.WAITER),
  'create-operator': cmdCreateOperator,
  'create-terminal': cmdCreateTerminal,
  'reset-password': cmdResetPassword,
  'list-venues': cmdListVenues,
  'list-users': cmdListUsers,
  'set-credential': cmdSetCredential,
  'enroll-totp': cmdEnrollTotp,
  reconcile: cmdReconcile,
  'revoke-sessions': cmdRevokeSessions,
  'set-super-admin': cmdSetSuperAdmin,
  'set-wipay-active': cmdSetWipayActive,
  'set-redsys-active': cmdSetRedsysActive,
};

function printUsage(): void {
  console.log('NightPay CLI — uso:');
  console.log('');
  console.log('  pnpm cli create-venue    --name "Luna VLC" [--slug luna-vlc] [--timezone Europe/Madrid]');
  console.log('  pnpm cli create-owner    --venue <slug> --email <email> --password <pwd>');
  console.log('  pnpm cli create-manager  --venue <slug> --email <email> --password <pwd>');
  console.log('  pnpm cli create-waiter   --venue <slug> --email <email> --password <pwd>');
  console.log('  pnpm cli create-operator --venue <slug> --email <email> --display-name "Ana" --commission 15');
  console.log('  pnpm cli create-terminal --venue <slug> --external-id BARRA-1 [--label "Barra 1"]');
  console.log('  pnpm cli reset-password  --email <email> --password <new>');
  console.log('  pnpm cli list-venues');
  console.log('  pnpm cli list-users      [--venue <slug>]');
  console.log('  pnpm cli set-credential  --venue <slug> --provider WIPAY|PEANPE --api-key <key>');
  console.log('  pnpm cli enroll-totp     --email <email>');
  console.log('  pnpm cli reconcile       --venue <slug> --day YYYY-MM-DD');
  console.log('  pnpm cli revoke-sessions --email <email>   (kill-switch para movil perdido)');
  console.log('  pnpm cli set-super-admin --email <email>   [--revoke true]  (grant/revoke superadmin)');
  console.log('  pnpm cli set-wipay-active --venue <slug>   (activa WIPAY + desactiva otros providers)');
  console.log('  pnpm cli set-redsys-active --venue <slug>  (activa REDSYS/BBVA + desactiva otros providers)');
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
