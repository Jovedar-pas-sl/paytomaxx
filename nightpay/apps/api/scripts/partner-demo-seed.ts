// La semilla de la demo de la API de socios (PR 8 parte A): las sociedades y
// locales de la demo, las 9 fichas de prueba del contrato y las fichas
// `demo-carga-…` de la prueba de carga. Solo en la demo: con el entorno que no
// vale (el freno de config/partner-test-mode.ts), sin la API en test o sin
// PARTNER_TEST_HELPERS=1 sale con 1 antes de abrir la base. Repetirla da los
// mismos recuentos. Solo escribe recuentos (nunca enlaces, UID ni saldos).
// Uso: pnpm --filter @nightpay/api partner:demo-seed [-- --carga 300]
// En el contenedor: node --import tsx scripts/partner-demo-seed.ts --carga 300
import { InvalidEnvError, parseEnv } from '../src/config/env';
import { demoSeedOptions, seedPartnerDemo } from '../src/modules/partner/test-helpers/partner-demo-fixtures';

async function main(): Promise<number> {
  try {
    parseEnv(process.env);
  } catch (err) {
    const where = err instanceof InvalidEnvError ? Object.keys(err.issues).join(', ') : (err as Error).name;
    console.error(`[partner-demo-seed] entorno inválido (${where}): no se toca la base.`);
    if (err instanceof InvalidEnvError) for (const [key, msgs] of Object.entries(err.issues)) console.error(`  ${key}: ${(msgs ?? []).join('; ')}`);
    return 1;
  }
  const opts = demoSeedOptions(process.env, process.argv.slice(2));
  if (!opts.ok) {
    console.error(`[partner-demo-seed] ${opts.reason} No se toca la base.`);
    return 1;
  }
  // Solo ahora el cliente de la base.
  const { PrismaClient } = await import('@nightpay/db');
  const prisma = new PrismaClient();
  try {
    // Como withBypass de packages/db/scripts/cli.ts: la semilla escribe en varios locales.
    const counts = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        return seedPartnerDemo(tx, { carga: opts.carga });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    console.log(`[partner-demo-seed] sociedades=${counts.sociedades} locales=${counts.locales} fichas=${counts.fichas} carga=${counts.carga}`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[partner-demo-seed] falló (${(err as Error).name}): no se guardó nada.`);
    process.exit(1);
  },
);
