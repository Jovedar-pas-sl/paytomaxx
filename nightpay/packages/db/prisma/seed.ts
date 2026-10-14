import { PrismaClient, Role, Provider } from '../src/generated/client';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Seed de desarrollo. Datos placeholder — ajustar con los reales
 * del usuario cuando corresponda. Las credenciales aquí NO se usan en
 * producción; son sólo para que el dev pueda probar login E2E.
 *
 * Venues: 6 locales (cámbialos por los reales).
 * Users: 1 OWNER (el usuario) + 4 MANAGERS, cada manager asignado a 1 venue.
 *
 * Como el usuario opera los 6 locales él mismo, el OWNER se asocia al venue
 * principal — puede cambiar de contexto en login con `venueSlug` (campo
 * de contrato `LoginRequest.venueSlug`).
 */

const DEMO_PASSWORD = 'nightpay-dev-2026'; // solo dev; cambiar via CLI para prod

const VENUES = [
  { name: 'Luna Valencia',   slug: 'luna-vlc',    timezone: 'Europe/Madrid', isPrimary: true  },
  { name: 'Luna Madrid',     slug: 'luna-mad',    timezone: 'Europe/Madrid', isPrimary: false },
  { name: 'Luna Marbella',   slug: 'luna-mrb',    timezone: 'Europe/Madrid', isPrimary: false },
  { name: 'Luna Ibiza',      slug: 'luna-ibz',    timezone: 'Europe/Madrid', isPrimary: false },
  { name: 'Luna Barcelona',  slug: 'luna-bcn',    timezone: 'Europe/Madrid', isPrimary: false },
  { name: 'Luna Sevilla',    slug: 'luna-svq',    timezone: 'Europe/Madrid', isPrimary: false },
];

// 4 managers: uno asignado a cada uno de los 4 primeros venues.
// Los otros 2 venues los gestiona el owner directo hasta contratar más staff.
const MANAGERS = [
  { email: 'manager.vlc@nightpay.local', venueSlug: 'luna-vlc' },
  { email: 'manager.mad@nightpay.local', venueSlug: 'luna-mad' },
  { email: 'manager.mrb@nightpay.local', venueSlug: 'luna-mrb' },
  { email: 'manager.ibz@nightpay.local', venueSlug: 'luna-ibz' },
];

async function main() {
  // Crea usuarios con una contraseña conocida: nunca contra producción.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== '1') {
    throw new Error('seed: no se ejecuta en producción (crea usuarios con contraseña conocida)');
  }
  console.log('Seeding NightPay dev database...');
  console.log('-'.repeat(60));

  // RLS bypass para todo el seed (somos sistema)
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);

    // 1) Venues
    const venues: Record<string, string> = {};
    for (const v of VENUES) {
      const created = await tx.venue.upsert({
        where: { slug: v.slug },
        update: { name: v.name, timezone: v.timezone },
        create: { name: v.name, slug: v.slug, timezone: v.timezone },
      });
      venues[v.slug] = created.id;
      console.log(`  venue  ${v.slug.padEnd(12)} → ${created.id}`);
    }

    // 2) Owner (el usuario). Asociado al venue primario.
    const primaryVenueSlug = VENUES.find((v) => v.isPrimary)?.slug ?? VENUES[0]!.slug;
    const primaryVenueId = venues[primaryVenueSlug]!;
    const ownerHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const owner = await tx.user.upsert({
      where: { email: 'owner@nightpay.local' },
      update: { passwordHash: ownerHash, role: Role.OWNER, tenantId: primaryVenueId, deletedAt: null },
      create: {
        email: 'owner@nightpay.local',
        passwordHash: ownerHash,
        role: Role.OWNER,
        tenantId: primaryVenueId,
      },
    });
    console.log(`  owner  ${owner.email.padEnd(32)} → venue ${primaryVenueSlug}`);

    // 3) Managers
    for (const m of MANAGERS) {
      const venueId = venues[m.venueSlug];
      if (!venueId) continue;
      const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
      const user = await tx.user.upsert({
        where: { email: m.email },
        update: { passwordHash: hash, role: Role.MANAGER, tenantId: venueId, deletedAt: null },
        create: {
          email: m.email,
          passwordHash: hash,
          role: Role.MANAGER,
          tenantId: venueId,
        },
      });
      console.log(`  mngr   ${user.email.padEnd(32)} → venue ${m.venueSlug}`);
    }

    // 4) Terminal demo por venue (2 por venue)
    for (const v of VENUES) {
      const venueId = venues[v.slug]!;
      for (let i = 1; i <= 2; i++) {
        const externalId = `BARRA-${i}`;
        await tx.terminal.upsert({
          where: { tenantId_externalId: { tenantId: venueId, externalId } },
          update: { label: `Barra ${i}` },
          create: { tenantId: venueId, externalId, label: `Barra ${i}` },
        });
      }
    }
    console.log(`  terminals × 2 por venue`);

    // 5) Credenciales de pasarela mock (placeholder cifrado) — 1 Wipay activa por venue
    for (const v of VENUES) {
      const venueId = venues[v.slug]!;
      const placeholder = Buffer.from(randomUUID());
      await tx.gatewayCredential.upsert({
        where: {
          tenantId_provider_active: {
            tenantId: venueId,
            provider: Provider.WIPAY,
            active: true,
          },
        },
        update: {},
        create: {
          tenantId: venueId,
          provider: Provider.WIPAY,
          encKey: placeholder,
          encNonce: placeholder,
          encTag: placeholder,
          kekVersion: 1,
        },
      });
    }
    console.log(`  gateway credentials (Wipay placeholder) × 6`);
  });

  console.log('-'.repeat(60));
  console.log('Credenciales de dev (cambiar via CLI antes de prod):');
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log(`  OWNER:    owner@nightpay.local`);
  console.log(`  MANAGERS: ${MANAGERS.map((m) => m.email).join(', ')}`);
  console.log('');
  console.log('Próximos pasos:');
  console.log('  curl -X POST http://localhost:3100/v1/auth/login \\');
  console.log('    -H "Content-Type: application/json" \\');
  console.log(`    -d '{"email":"owner@nightpay.local","password":"${DEMO_PASSWORD}"}'`);
  console.log('');
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
