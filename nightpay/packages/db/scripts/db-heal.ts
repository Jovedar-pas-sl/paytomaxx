#!/usr/bin/env node
/**
 * db-heal — comprobaciones de la base al arrancar el API, antes y después de
 * `prisma migrate deploy` (ver CMD de apps/api/Dockerfile).
 *
 * Ya NO cambia ni el esquema ni los datos. Lo que antes hacía en cada arranque
 * (columnas, NOT NULL, CHECKs —borrando liquidaciones a 0 €—, y activar Redsys
 * en todos los locales desactivando las demás pasarelas) está congelado en la
 * migración 20261015080000_congelar_db_heal; activar Redsys en un local es un
 * paso aparte y explícito: scripts/activate-redsys.ts.
 *
 * Qué hace:
 *   1. Base nueva (sin _prisma_migrations): nada, primero las migraciones.
 *   2. Migraciones fallidas: las nombra y dice cómo resolverlas. No las toca:
 *      `prisma migrate deploy` se negará a seguir y el API no arrancará hasta
 *      que alguien las mire (una migración a medias no se da por buena).
 *   3. Comprobaciones de solo lectura: CHECKs o claves ajenas que quedaron
 *      NOT VALID (filas antiguas que no los cumplen) → aviso en el log.
 *
 * Sale con 0 (también si no hay nada que decir). Con 1 solo si no puede
 * conectar con la base.
 */

import { PrismaClient } from '../src/generated/client';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('[db-heal] DATABASE_URL no está definida: nada que comprobar');
    return;
  }

  const prisma = new PrismaClient({ log: ['error'] });
  try {
    // Base de datos nueva (instalación desde cero, copia restaurada vacía…):
    // las migraciones la crean y el arranque vuelve a pasar por aquí después.
    const ready = await prisma.$queryRawUnsafe<Array<{ t: string | null }>>(
      `SELECT to_regclass('public._prisma_migrations')::text AS t`,
    );
    if (!ready[0]?.t) {
      console.log('[db-heal] base de datos nueva: primero las migraciones');
      return;
    }

    // Una migración que falló NO se da por aplicada: su SQL se deshizo entero
    // y la app arrancaría con la base a medias sin avisar.
    const failed = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NULL AND rolled_back_at IS NULL
        ORDER BY started_at`,
    );
    if (failed.length > 0) {
      console.error(
        `[db-heal] MIGRACIONES FALLIDAS (no se tocan): ${failed.map((r) => r.migration_name).join(', ')}. ` +
          'Mira su error en el log, arréglalo y márcala con `prisma migrate resolve --rolled-back <nombre>` ' +
          'antes de volver a desplegar (ver docs/DOKPLOY-STEPS.md, «Si falla una migración»).',
      );
    } else {
      console.log('[db-heal] migraciones: ninguna fallida');
    }

    // Restricciones que una migración dejó NOT VALID porque había filas
    // antiguas que no las cumplían: obligan a las filas nuevas, pero esas
    // filas hay que revisarlas a mano. Solo se avisa.
    const notValid = await prisma.$queryRawUnsafe<Array<{ tabla: string; nombre: string }>>(
      `SELECT conrelid::regclass::text AS tabla, conname AS nombre
         FROM pg_constraint
        WHERE NOT convalidated AND connamespace = 'public'::regnamespace
        ORDER BY 1, 2`,
    );
    for (const c of notValid) {
      console.warn(
        `[db-heal] aviso: ${c.tabla}.${c.nombre} está NOT VALID: hay filas antiguas que no la cumplen (revísalas a mano)`,
      );
    }
  } catch (e) {
    console.error('[db-heal] FATAL:', (e as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
