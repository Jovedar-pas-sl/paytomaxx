#!/usr/bin/env node
/**
 * db-heal — self-healing pre-migrate step.
 *
 * Runs BEFORE `prisma migrate deploy` on every container startup. Idempotent.
 *
 * Why this exists:
 *   `prisma migrate deploy` refuses to run if ANY migration in `_prisma_migrations`
 *   is in a failed state (finished_at IS NULL). On a production box without
 *   shell access, a partially-applied migration can wedge all subsequent deploys.
 *
 * IMPORTANT: Prisma's $executeRawUnsafe uses extended query protocol which only
 *   runs ONE statement per call (any `;` after the first is ignored). So every
 *   ALTER must be its own line in the steps array.
 *
 * Exits 0 on success (including no-op). Exits 1 only on connect failure.
 */

import { PrismaClient } from '../src/generated/client';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[db-heal] DATABASE_URL not set — skipping');
    process.exit(0);
  }

  const prisma = new PrismaClient({ log: ['error'] });

  try {
    const failed = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL`,
    );
    if (failed.length > 0) {
      console.log(
        `[db-heal] marking ${failed.length} stuck migration(s) as resolved:`,
        failed.map((r) => r.migration_name).join(', '),
      );
      await prisma.$executeRawUnsafe(
        `UPDATE _prisma_migrations SET finished_at = NOW(), logs = COALESCE(logs,'') || E'\n[db-heal] auto-resolved' WHERE finished_at IS NULL`,
      );
    } else {
      console.log('[db-heal] no stuck migrations');
    }

    // Cada step = UN solo statement SQL (Prisma extended protocol limitation).
    const steps: Array<{ name: string; sql: string }> = [
      // ─── venues ────────────────────────────────────────────────────
      { name: 'venues.operatorCommissionDefaults add', sql: `ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "operatorCommissionDefaults" JSONB DEFAULT '{"CHICA_SERVICE":9000,"VENUE_BAR":0,"VENUE_ROOM":0,"VENUE_FOOD":0,"EXTRA":0}'::jsonb` },
      { name: 'venues.operatorCommissionDefaults backfill', sql: `UPDATE "venues" SET "operatorCommissionDefaults" = '{"CHICA_SERVICE":9000,"VENUE_BAR":0,"VENUE_ROOM":0,"VENUE_FOOD":0,"EXTRA":0}'::jsonb WHERE "operatorCommissionDefaults" IS NULL` },
      { name: 'venues.operatorCommissionDefaults set not null', sql: `ALTER TABLE "venues" ALTER COLUMN "operatorCommissionDefaults" SET NOT NULL` },
      { name: 'venues.platformCommissionBps add', sql: `ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "platformCommissionBps" INT DEFAULT 1000` },
      { name: 'venues.platformCommissionBps backfill', sql: `UPDATE "venues" SET "platformCommissionBps" = 1000 WHERE "platformCommissionBps" IS NULL` },
      { name: 'venues.platformCommissionBps set not null', sql: `ALTER TABLE "venues" ALTER COLUMN "platformCommissionBps" SET NOT NULL` },
      { name: 'venues.operatorMaxCobroCents add', sql: `ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "operatorMaxCobroCents" INT DEFAULT 20000` },
      { name: 'venues.operatorMaxCobroCents backfill', sql: `UPDATE "venues" SET "operatorMaxCobroCents" = 20000 WHERE "operatorMaxCobroCents" IS NULL` },
      { name: 'venues.operatorMaxCobroCents set not null', sql: `ALTER TABLE "venues" ALTER COLUMN "operatorMaxCobroCents" SET NOT NULL` },
      { name: 'venues.vatBps add', sql: `ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "vatBps" INT DEFAULT 2100` },
      { name: 'venues.vatRegime add', sql: `ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "vatRegime" TEXT DEFAULT 'GENERAL'` },
      { name: 'venues.vatBps backfill', sql: `UPDATE "venues" SET "vatBps" = 2100 WHERE "vatBps" IS NULL` },
      { name: 'venues.vatRegime backfill', sql: `UPDATE "venues" SET "vatRegime" = 'GENERAL' WHERE "vatRegime" IS NULL` },
      { name: 'venues.vatBps set not null', sql: `ALTER TABLE "venues" ALTER COLUMN "vatBps" SET NOT NULL` },
      { name: 'venues.vatRegime set not null', sql: `ALTER TABLE "venues" ALTER COLUMN "vatRegime" SET NOT NULL` },

      // ─── payments ──────────────────────────────────────────────────
      { name: 'payments.captureMethod add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "captureMethod" TEXT` },
      { name: 'payments.walletId add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "walletId" UUID` },
      { name: 'payments.platformCommissionBps add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "platformCommissionBps" INT` },
      { name: 'payments.revenueCategory add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "revenueCategory" TEXT DEFAULT 'EXTRA'` },
      { name: 'payments.revenueCategory backfill', sql: `UPDATE "payments" SET "revenueCategory" = CASE WHEN "walletId" IS NULL AND "createdByUserId" IS NOT NULL THEN 'CHICA_SERVICE' ELSE 'EXTRA' END WHERE "revenueCategory" IS NULL` },
      { name: 'payments.revenueCategory set not null', sql: `ALTER TABLE "payments" ALTER COLUMN "revenueCategory" SET NOT NULL` },
      { name: 'payments.tipCents add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "tipCents" INT DEFAULT 0` },
      { name: 'payments.tipGoesTo add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "tipGoesTo" TEXT` },
      { name: 'payments.tipBeneficiaryUserId add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "tipBeneficiaryUserId" UUID` },
      { name: 'payments.gatewayPaymentUrl add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "gatewayPaymentUrl" TEXT` },
      { name: 'payments.gatewayCheckoutForm add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "gatewayCheckoutForm" JSONB` },
      // Tokenización Redsys / Peanpe: si el adapter recibe en el callback un
      // identifier (token de tarjeta) + last4/expiry/brand, los persistimos
      // aquí para reusar en cobros recurrentes MIT (PIN-flow).
      // Shape: { identifier, expiry, cardLast4, cardBrand, cofTxnId, capturedAt }
      { name: 'payments.tokenizationData add', sql: `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "tokenizationData" JSONB` },
      { name: 'payments.tipCents backfill', sql: `UPDATE "payments" SET "tipCents" = 0 WHERE "tipCents" IS NULL` },
      { name: 'payments.tipCents set not null', sql: `ALTER TABLE "payments" ALTER COLUMN "tipCents" SET NOT NULL` },

      // ─── terminals ─────────────────────────────────────────────────
      { name: 'terminals.zone add', sql: `ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "zone" TEXT` },
      { name: 'terminals.hardwareModel add', sql: `ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "hardwareModel" TEXT` },
      { name: 'terminals.deviceSerial add', sql: `ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "deviceSerial" TEXT` },

      // ─── users ─────────────────────────────────────────────────────
      { name: 'users.isSuperAdmin add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isSuperAdmin" BOOLEAN DEFAULT false` },
      { name: 'users.isSuperAdmin backfill', sql: `UPDATE "users" SET "isSuperAdmin" = false WHERE "isSuperAdmin" IS NULL` },
      { name: 'users.isSuperAdmin set not null', sql: `ALTER TABLE "users" ALTER COLUMN "isSuperAdmin" SET NOT NULL` },
      { name: 'users.displayName add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "displayName" TEXT` },
      { name: 'users.invitedAt add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "invitedAt" TIMESTAMPTZ` },
      { name: 'users.inviteToken add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "inviteToken" TEXT` },
      { name: 'users.selfOnboardingToken add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "selfOnboardingToken" TEXT` },
      { name: 'users.commissionBps add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "commissionBps" INT` },
      { name: 'users.payoutMethod add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutMethod" TEXT` },
      { name: 'users.payoutAddress add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutAddress" TEXT` },
      { name: 'users.payoutMetadata add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutMetadata" JSONB` },
      { name: 'users.payoutLabel add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutLabel" TEXT` },
      { name: 'users.phone add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" TEXT` },
      { name: 'users.passportCountry add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passportCountry" TEXT` },
      { name: 'users.passportLast4 add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passportLast4" TEXT` },
      { name: 'users.hasEmpadronamiento add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hasEmpadronamiento" BOOLEAN DEFAULT false` },
      { name: 'users.hasEmpadronamiento backfill', sql: `UPDATE "users" SET "hasEmpadronamiento" = false WHERE "hasEmpadronamiento" IS NULL` },
      { name: 'users.hasNie add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hasNie" BOOLEAN DEFAULT false` },
      { name: 'users.hasNie backfill', sql: `UPDATE "users" SET "hasNie" = false WHERE "hasNie" IS NULL` },
      { name: 'users.hasTie add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hasTie" BOOLEAN DEFAULT false` },
      { name: 'users.hasTie backfill', sql: `UPDATE "users" SET "hasTie" = false WHERE "hasTie" IS NULL` },
      { name: 'users.walletProvider add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "walletProvider" TEXT` },
      { name: 'users.walletStatus add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "walletStatus" TEXT` },
      { name: 'users.walletTestPassed add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "walletTestPassed" BOOLEAN DEFAULT false` },
      { name: 'users.walletTestPassed backfill', sql: `UPDATE "users" SET "walletTestPassed" = false WHERE "walletTestPassed" IS NULL` },
      { name: 'users.walletTestAt add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "walletTestAt" TIMESTAMPTZ` },
      { name: 'users.needsHelpWallet add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "needsHelpWallet" BOOLEAN DEFAULT false` },
      { name: 'users.needsHelpWallet backfill', sql: `UPDATE "users" SET "needsHelpWallet" = false WHERE "needsHelpWallet" IS NULL` },
      { name: 'users.needsHelpDocs add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "needsHelpDocs" BOOLEAN DEFAULT false` },
      { name: 'users.needsHelpDocs backfill', sql: `UPDATE "users" SET "needsHelpDocs" = false WHERE "needsHelpDocs" IS NULL` },
      { name: 'users.onboardingStatus add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboardingStatus" TEXT DEFAULT 'NEW'` },
      { name: 'users.onboardingStatus backfill', sql: `UPDATE "users" SET "onboardingStatus" = 'NEW' WHERE "onboardingStatus" IS NULL` },
      { name: 'users.onboardingNotes add', sql: `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboardingNotes" TEXT` },

      // ─── Provider enum ─────────────────────────────────────────────
      { name: 'Provider enum +PAYTEF', sql: `DO $$ BEGIN ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'PAYTEF'; EXCEPTION WHEN undefined_object THEN NULL; END $$` },
      { name: 'Provider enum +REDSYS', sql: `DO $$ BEGIN ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'REDSYS'; EXCEPTION WHEN undefined_object THEN NULL; END $$` },

      // ─── CHECK constraints — clean data first, then re-add ─────────
      { name: 'drop operator_payouts CHECK', sql: `ALTER TABLE "operator_payouts" DROP CONSTRAINT IF EXISTS operator_payouts_total_positive` },
      { name: 'clean operator_payouts bad data', sql: `DELETE FROM "operator_payouts" WHERE "totalCents" <= 0` },
      { name: 'add operator_payouts CHECK', sql: `ALTER TABLE "operator_payouts" ADD CONSTRAINT operator_payouts_total_positive CHECK ("totalCents" > 0)` },
      { name: 'drop operator_earnings CHECK', sql: `ALTER TABLE "operator_earnings" DROP CONSTRAINT IF EXISTS operator_earnings_reversed_bounded` },
      { name: 'clean operator_earnings high reversedCents', sql: `UPDATE "operator_earnings" SET "reversedCents" = LEAST("reversedCents", "commissionCents" + COALESCE("tipCents",0)) WHERE "reversedCents" > "commissionCents" + COALESCE("tipCents",0)` },
      { name: 'clean operator_earnings negative reversedCents', sql: `UPDATE "operator_earnings" SET "reversedCents" = 0 WHERE "reversedCents" < 0` },
      { name: 'add operator_earnings CHECK', sql: `ALTER TABLE "operator_earnings" ADD CONSTRAINT operator_earnings_reversed_bounded CHECK ("reversedCents" >= 0 AND "reversedCents" <= "commissionCents" + COALESCE("tipCents", 0))` },
      { name: 'drop payments revenueCategory CHECK', sql: `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS payments_revenue_category_valid` },
      { name: 'clean payments bad revenueCategory', sql: `UPDATE "payments" SET "revenueCategory" = 'EXTRA' WHERE "revenueCategory" NOT IN ('CHICA_SERVICE','VENUE_BAR','VENUE_ROOM','VENUE_FOOD','EXTRA')` },
      { name: 'add payments revenueCategory CHECK', sql: `ALTER TABLE "payments" ADD CONSTRAINT payments_revenue_category_valid CHECK ("revenueCategory" IN ('CHICA_SERVICE','VENUE_BAR','VENUE_ROOM','VENUE_FOOD','EXTRA'))` },
    ];

    let okCount = 0;
    let errCount = 0;
    for (const step of steps) {
      try {
        await prisma.$executeRawUnsafe(step.sql);
        okCount++;
      } catch (e) {
        errCount++;
        console.error(`[db-heal] err ${step.name}: ${(e as Error).message}`);
      }
    }
    console.log(`[db-heal] done — ${okCount} ok, ${errCount} err out of ${steps.length} steps`);

    // ─── Auto-activación de provider según env vars ───────────────────
    // Si REDSYS_MERCHANT_CODE está definido, activamos REDSYS para todos
    // los venues y desactivamos cualquier otro provider activo.
    // Idempotente: si ya está activo, no hace nada.
    if (process.env.REDSYS_MERCHANT_CODE && process.env.REDSYS_SECRET_KEY) {
      try {
        const venues = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM venues WHERE "deletedAt" IS NULL`,
        );
        for (const venue of venues) {
          // Desactivar todos los providers activos del venue (PAYTEF, WIPAY, etc.)
          await prisma.$executeRawUnsafe(
            `UPDATE gateway_credentials SET active = false WHERE "tenantId" = $1::uuid AND active = true AND provider != 'REDSYS'`,
            venue.id,
          );
          // Comprobar si ya existe fila REDSYS
          const existing = await prisma.$queryRawUnsafe<Array<{ id: string; active: boolean }>>(
            `SELECT id, active FROM gateway_credentials WHERE "tenantId" = $1::uuid AND provider = 'REDSYS' LIMIT 1`,
            venue.id,
          );
          if (existing.length === 0) {
            // Crear nueva fila REDSYS activa (dummy bytes — adapter lee creds de env)
            await prisma.$executeRawUnsafe(
              `INSERT INTO gateway_credentials (id, "tenantId", provider, active, "encKey", "encNonce", "encTag", "kekVersion", "createdAt")
               VALUES (gen_random_uuid(), $1::uuid, 'REDSYS', true, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, 1, now())`,
              venue.id,
            );
            console.log(`[db-heal] REDSYS creado y activado para venue ${venue.id}`);
          } else if (!existing[0]!.active) {
            await prisma.$executeRawUnsafe(
              `UPDATE gateway_credentials SET active = true WHERE id = $1::uuid`,
              existing[0]!.id,
            );
            console.log(`[db-heal] REDSYS reactivado para venue ${venue.id}`);
          }
        }
        console.log(`[db-heal] REDSYS auto-activation: ${venues.length} venue(s) procesados`);
      } catch (e) {
        console.error(`[db-heal] err REDSYS auto-activation: ${(e as Error).message}`);
      }
    } else {
      console.log('[db-heal] REDSYS env vars no configuradas — auto-activation skip');
    }
  } catch (e) {
    console.error('[db-heal] FATAL:', (e as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
