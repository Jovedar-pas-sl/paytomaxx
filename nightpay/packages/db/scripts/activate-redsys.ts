#!/usr/bin/env node
/**
 * activate-redsys — deja Redsys (el TPV de BBVA) como la pasarela activa de un
 * local, o de todos, desactivando las demás.
 *
 * Antes lo hacía db-heal en CADA arranque del API en cuanto había REDSYS_* en
 * el entorno, para todos los locales y pasando por encima de la pasarela que
 * el dueño hubiera elegido. Ahora es un paso explícito, una vez y a propósito.
 * Producción ya tiene Redsys activo: solo hace falta para un local nuevo.
 *
 * Uso, desde packages/db, con el DATABASE_URL y las REDSYS_* del API (en
 * Dokploy: nightpay-api → Terminal → `cd /repo/packages/db`):
 *
 *   ./node_modules/.bin/tsx scripts/activate-redsys.ts --venue <slug>          (enseña qué cambiaría)
 *   ./node_modules/.bin/tsx scripts/activate-redsys.ts --venue <slug> --apply  (lo cambia)
 *   ./node_modules/.bin/tsx scripts/activate-redsys.ts --all [--apply]         (todos los locales)
 *
 * Las claves de Redsys no se guardan en la base: el adaptador las lee de las
 * variables REDSYS_*; la fila de gateway_credentials solo dice qué pasarela usa
 * el local (lleva bytes de relleno, como `pnpm cli set-redsys-active`).
 */

import { Prisma, PrismaClient } from '../src/generated/client';

const USAGE =
  'uso: tsx scripts/activate-redsys.ts (--venue <slug> | --all) [--apply]\n' +
  '     sin --apply solo enseña lo que cambiaría';

function fail(msg: string): never {
  console.error(`[activate-redsys] ${msg}\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { venue?: string; all: boolean; apply: boolean } {
  const i = argv.indexOf('--venue');
  const venue = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && (!venue || venue.startsWith('--'))) fail('falta el slug después de --venue');
  const all = argv.includes('--all');
  if (!venue && !all) fail('indica --venue <slug> o --all');
  if (venue && all) fail('--venue o --all, no los dos');
  return { venue, all, apply: argv.includes('--apply') };
}

/** Lo que haría falta en un local para que cobre con Redsys y solo con Redsys. */
interface Plan {
  deactivate: Array<{ id: string; provider: string }>;
  redsys: { id: string; active: boolean } | null;
}

function describe(plan: Plan): string[] {
  const out = plan.deactivate.map((c) => `desactivar ${c.provider}`);
  if (!plan.redsys) out.push('crear REDSYS activo');
  else if (!plan.redsys.active) out.push('reactivar REDSYS');
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) fail('DATABASE_URL no está definida');
  // Sin las claves, el local quedaría con Redsys activo y sin poder cobrar.
  if (!process.env.REDSYS_MERCHANT_CODE || !process.env.REDSYS_SECRET_KEY) {
    fail('faltan REDSYS_MERCHANT_CODE / REDSYS_SECRET_KEY en el entorno (las del API)');
  }

  // Sin log de Prisma: los errores se explican abajo, local por local.
  const prisma = new PrismaClient();
  // gateway_credentials y venues tienen RLS: el script trabaja como sistema.
  const asSystem = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
      return fn(tx);
    });

  try {
    const venues = await asSystem((tx) =>
      tx.venue.findMany({
        where: { deletedAt: null, ...(opts.venue ? { slug: opts.venue } : {}) },
        select: { id: true, slug: true },
        orderBy: { slug: 'asc' },
      }),
    );
    if (venues.length === 0) fail(opts.venue ? `no hay ningún local con slug "${opts.venue}"` : 'no hay locales');

    let pending = 0;
    let failed = 0;
    for (const v of venues) {
      try {
        // Cada local en su transacción: si uno falla, los demás siguen.
        const steps = await asSystem(async (tx) => {
          const creds = await tx.gatewayCredential.findMany({
            where: { tenantId: v.id },
            select: { id: true, provider: true, active: true },
          });
          const plan: Plan = {
            deactivate: creds.filter((c) => c.active && c.provider !== 'REDSYS'),
            redsys:
              creds.find((c) => c.provider === 'REDSYS' && c.active) ??
              creds.find((c) => c.provider === 'REDSYS') ??
              null,
          };
          const todo = describe(plan);
          if (!opts.apply || todo.length === 0) return todo;

          if (plan.deactivate.length > 0) {
            await tx.gatewayCredential.updateMany({
              where: { id: { in: plan.deactivate.map((c) => c.id) } },
              data: { active: false },
            });
          }
          if (!plan.redsys) {
            const filler = Buffer.from([0]);
            await tx.gatewayCredential.create({
              data: {
                tenantId: v.id,
                provider: 'REDSYS',
                encKey: filler,
                encNonce: filler,
                encTag: filler,
                kekVersion: 1,
                active: true,
              },
            });
          } else if (!plan.redsys.active) {
            await tx.gatewayCredential.update({ where: { id: plan.redsys.id }, data: { active: true } });
          }
          return todo;
        });

        if (steps.length === 0) {
          console.log(`  ${v.slug}: ya cobra con Redsys, nada que cambiar`);
        } else {
          pending += 1;
          console.log(`  ${v.slug}: ${opts.apply ? 'hecho' : 'haría'} → ${steps.join(', ')}`);
        }
      } catch (e) {
        failed += 1;
        const dup = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        console.error(
          `  ${v.slug}: NO se pudo — ` +
            (dup
              ? 'ya hay otra fila inactiva de esa pasarela (solo puede haber una por local, pasarela y estado); revísalo a mano'
              : (e as Error).message),
        );
      }
    }

    if (!opts.apply && pending > 0) {
      console.log(`\n${pending} local(es) por cambiar. Vuelve a lanzarlo con --apply para hacerlo.`);
    }
    if (failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error('[activate-redsys] FATAL:', (e as Error).message);
  process.exit(1);
});
