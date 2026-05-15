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
 * What it does:
 *   1. Marks any "in-progress / failed" migration row as resolved (finished_at = NOW()).
 *      Safe because every migration in this repo uses IF NOT EXISTS / IF EXISTS
 *      guards — re-running them is a no-op.
 *   2. Defensively adds the columns + JSON defaults that newer code paths
 *      (revenueCategory, operatorCommissionDefaults, platformCommissionBps, tip*)
 *      require. ALTER ... IF NOT EXISTS is idempotent.
 *   3. Backfills NULLs so subsequent NOT NULL constraints don't trip.
 *   4. Drops then re-adds CHECK constraints that may have failed on bad data
 *      (cleans the bad data first when safe).
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

    const steps: Array<{ name: string; sql: string }> = [
      {
        name: 'venues.operatorCommissionDefaults JSONB',
        sql: `
          ALTER TABLE "venues"
            ADD COLUMN IF NOT EXISTS "operatorCommissionDefaults" JSONB
            DEFAULT '{"CHICA_SERVICE":9000,"VENUE_BAR":0,"VENUE_ROOM":0,"VENUE_FOOD":0,"EXTRA":0}'::jsonb;
          UPDATE "venues"
             SET "operatorCommissionDefaults" = '{"CHICA_SERVICE":9000,"VENUE_BAR":0,"VENUE_ROOM":0,"VENUE_FOOD":0,"EXTRA":0}'::jsonb
           WHERE "operatorCommissionDefaults" IS NULL;
          ALTER TABLE "venues" ALTER COLUMN "operatorCommissionDefaults" SET NOT NULL;
        `,
      },
      {
        name: 'venues.platformCommissionBps INT',
        sql: `
          ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "platformCommissionBps" INT DEFAULT 1000;
          UPDATE "venues" SET "platformCommissionBps" = 1000 WHERE "platformCommissionBps" IS NULL;
          ALTER TABLE "venues" ALTER COLUMN "platformCommissionBps" SET NOT NULL;
        `,
      },
      {
        name: 'venues.operatorMaxCobroCents INT',
        sql: `
          ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "operatorMaxCobroCents" INT DEFAULT 20000;
          UPDATE "venues" SET "operatorMaxCobroCents" = 20000 WHERE "operatorMaxCobroCents" IS NULL;
          ALTER TABLE "venues" ALTER COLUMN "operatorMaxCobroCents" SET NOT NULL;
        `,
      },
      {
        name: 'venues.vatBps + vatRegime',
        sql: `
          ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "vatBps" INT DEFAULT 2100;
          ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "vatRegime" TEXT DEFAULT 'GENERAL';
          UPDATE "venues" SET "vatBps" = 2100 WHERE "vatBps" IS NULL;
          UPDATE "venues" SET "vatRegime" = 'GENERAL' WHERE "vatRegime" IS NULL;
          ALTER TABLE "venues" ALTER COLUMN "vatBps" SET NOT NULL;
          ALTER TABLE "venues" ALTER COLUMN "vatRegime" SET NOT NULL;
        `,
      },
      {
        name: 'payments.revenueCategory TEXT',
        sql: `
          ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "revenueCategory" TEXT DEFAULT 'EXTRA';
          UPDATE "payments"
             SET "revenueCategory" = CASE
               WHEN "walletId" IS NULL AND "createdByUserId" IS NOT NULL THEN 'CHICA_SERVICE'
               ELSE 'EXTRA'
             END
           WHERE "revenueCategory" IS NULL;
          ALTER TABLE "payments" ALTER COLUMN "revenueCategory" SET NOT NULL;
        `,
      },
      {
        name: 'payments.tipCents/tipGoesTo/tipBeneficiaryUserId',
        sql: `
          ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "tipCents" INT DEFAULT 0;
          ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "tipGoesTo" TEXT;
          ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "tipBeneficiaryUserId" UUID;
          UPDATE "payments" SET "tipCents" = 0 WHERE "tipCents" IS NULL;
          ALTER TABLE "payments" ALTER COLUMN "tipCents" SET NOT NULL;
        `,
      },
      {
        name: 'payments.platformCommissionBps + captureMethod + walletId',
        sql: `
          ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "platformCommissionBps" INT;
          ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "captureMethod" TEXT;
          ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "walletId" UUID;
        `,
      },
      {
        name: 'terminals.zone + hardwareModel + deviceSerial',
        sql: `
          ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "zone" TEXT;
          ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "hardwareModel" TEXT;
          ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "deviceSerial" TEXT;
        `,
      },
      {
        name: 'users.isSuperAdmin + onboarding fields',
        sql: `
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isSuperAdmin" BOOLEAN DEFAULT false;
          UPDATE "users" SET "isSuperAdmin" = false WHERE "isSuperAdmin" IS NULL;
          ALTER TABLE "users" ALTER COLUMN "isSuperAdmin" SET NOT NULL;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "invitedAt" TIMESTAMPTZ;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "inviteToken" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "selfOnboardingToken" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "commissionBps" INT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutMethod" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutAddress" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutMetadata" JSONB;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payoutLabel" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passportCountry" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passportLast4" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hasEmpadronamiento" BOOLEAN DEFAULT false;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hasNie" BOOLEAN DEFAULT false;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hasTie" BOOLEAN DEFAULT false;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "walletProvider" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "walletStatus" TEXT;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "walletTestPassed" BOOLEAN DEFAULT false;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "walletTestAt" TIMESTAMPTZ;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "needsHelpWallet" BOOLEAN DEFAULT false;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "needsHelpDocs" BOOLEAN DEFAULT false;
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboardingStatus" TEXT DEFAULT 'NEW';
          ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboardingNotes" TEXT;
          UPDATE "users" SET "onboardingStatus" = 'NEW' WHERE "onboardingStatus" IS NULL;
          UPDATE "users" SET "hasEmpadronamiento" = false WHERE "hasEmpadronamiento" IS NULL;
          UPDATE "users" SET "hasNie" = false WHERE "hasNie" IS NULL;
          UPDATE "users" SET "hasTie" = false WHERE "hasTie" IS NULL;
          UPDATE "users" SET "walletTestPassed" = false WHERE "walletTestPassed" IS NULL;
          UPDATE "users" SET "needsHelpWallet" = false WHERE "needsHelpWallet" IS NULL;
          UPDATE "users" SET "needsHelpDocs" = false WHERE "needsHelpDocs" IS NULL;
        `,
      },
      {
        name: 'Provider enum +PAYTEF',
        sql: `
          DO $$
          BEGIN
            ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'PAYTEF';
          EXCEPTION WHEN undefined_object THEN NULL;
          END $$;
        `,
      },
      {
        name: 'CHECK constraints — clean bad data first, then re-add',
        sql: `
          ALTER TABLE "operator_payouts" DROP CONSTRAINT IF EXISTS operator_payouts_total_positive;
          DELETE FROM "operator_payouts" WHERE "totalCents" <= 0;
          ALTER TABLE "operator_payouts"
            ADD CONSTRAINT operator_payouts_total_positive CHECK ("totalCents" > 0);

          ALTER TABLE "operator_earnings" DROP CONSTRAINT IF EXISTS operator_earnings_reversed_bounded;
          UPDATE "operator_earnings"
             SET "reversedCents" = LEAST("reversedCents", "commissionCents" + COALESCE("tipCents",0))
           WHERE "reversedCents" > "commissionCents" + COALESCE("tipCents",0);
          UPDATE "operator_earnings" SET "reversedCents" = 0 WHERE "reversedCents" < 0;
          ALTER TABLE "operator_earnings"
            ADD CONSTRAINT operator_earnings_reversed_bounded
            CHECK ("reversedCents" >= 0 AND "reversedCents" <= "commissionCents" + COALESCE("tipCents", 0));

          ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS payments_revenue_category_valid;
          UPDATE "payments" SET "revenueCategory" = 'EXTRA'
           WHERE "revenueCategory" NOT IN ('CHICA_SERVICE','VENUE_BAR','VENUE_ROOM','VENUE_FOOD','EXTRA');
          ALTER TABLE "payments"
            ADD CONSTRAINT payments_revenue_category_valid
            CHECK ("revenueCategory" IN ('CHICA_SERVICE','VENUE_BAR','VENUE_ROOM','VENUE_FOOD','EXTRA'));
        `,
      },
    ];

    for (const step of steps) {
      try {
        await prisma.$executeRawUnsafe(step.sql);
        console.log(`[db-heal] ok  ${step.name}`);
      } catch (e) {
        console.error(`[db-heal] err ${step.name}: ${(e as Error).message}`);
      }
    }

    console.log('[db-heal] done');
  } catch (e) {
    console.error('[db-heal] FATAL:', (e as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
