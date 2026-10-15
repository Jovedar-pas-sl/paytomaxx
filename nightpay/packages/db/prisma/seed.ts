import { PrismaClient, Role, Provider } from '../src/generated/client';
import { randomBytes, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Seed de DESARROLLO: 6 locales de ejemplo, 1 OWNER + 4 MANAGERS, 2 terminales
 * por local y una pasarela de prueba en los locales que no tengan ninguna.
 *
 * Contraseña de los usuarios NUEVOS: SEED_PASSWORD (mín. 12 caracteres). Si no
 * se da, en desarrollo se genera una al azar y se enseña una vez al final; en
 * producción (NODE_ENV=production) el seed no arranca sin SEED_PASSWORD.
 *
 * Nunca toca lo que ya existe: ni contraseñas, ni roles, ni nombres de locales,
 * ni terminales, ni pasarelas. Solo crea lo que falta. No va en la imagen
 * Docker del API (.dockerignore).
 */

const MIN_PASSWORD = 12;

function seedPassword(): { password: string; generated: boolean } {
  const given = process.env.SEED_PASSWORD;
  if (given) {
    if (given.length < MIN_PASSWORD) {
      throw new Error(`seed: SEED_PASSWORD necesita al menos ${MIN_PASSWORD} caracteres`);
    }
    return { password: given, generated: false };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'seed: en producción hace falta SEED_PASSWORD (la contraseña de los usuarios que cree). ' +
        'Los que ya existan no se tocan.',
    );
  }
  return { password: randomBytes(12).toString('base64url'), generated: true };
}

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
  const { password, generated } = seedPassword();
  console.log('Seed de desarrollo de NightPay (solo crea lo que falta)...');
  console.log('-'.repeat(60));
  const created: string[] = [];

  // RLS bypass para todo el seed (somos sistema)
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);

    // 1) Locales: si el slug ya existe, se deja como está.
    const venues: Record<string, string> = {};
    for (const v of VENUES) {
      const venue =
        (await tx.venue.findUnique({ where: { slug: v.slug } })) ??
        (await tx.venue.create({ data: { name: v.name, slug: v.slug, timezone: v.timezone } }));
      venues[v.slug] = venue.id;
      console.log(`  local  ${v.slug.padEnd(12)} → ${venue.id}`);
    }

    // 2) Usuarios: solo se crean; uno que ya existe NO se toca (ni su contraseña).
    const hash = await bcrypt.hash(password, 10);
    const primarySlug = VENUES.find((v) => v.isPrimary)?.slug ?? VENUES[0]!.slug;
    const people = [
      { email: 'owner@nightpay.local', role: Role.OWNER, venueSlug: primarySlug },
      ...MANAGERS.map((m) => ({ email: m.email, role: Role.MANAGER, venueSlug: m.venueSlug })),
    ];
    for (const p of people) {
      const tenantId = venues[p.venueSlug];
      if (!tenantId) continue;
      const existing = await tx.user.findUnique({ where: { email: p.email } });
      if (existing) {
        console.log(`  user   ${p.email.padEnd(32)} ya existe: no se toca`);
        continue;
      }
      await tx.user.create({ data: { email: p.email, passwordHash: hash, role: p.role, tenantId } });
      created.push(p.email);
      console.log(`  user   ${p.email.padEnd(32)} creado (${p.role}, ${p.venueSlug})`);
    }

    // 3) Dos terminales de barra por local (si faltan).
    for (const v of VENUES) {
      const venueId = venues[v.slug]!;
      for (let i = 1; i <= 2; i++) {
        const externalId = `BARRA-${i}`;
        await tx.terminal.upsert({
          where: { tenantId_externalId: { tenantId: venueId, externalId } },
          update: {},
          create: { tenantId: venueId, externalId, label: `Barra ${i}` },
        });
      }
    }
    console.log('  terminales: BARRA-1 y BARRA-2 en cada local (si faltaban)');

    // 4) Pasarela de prueba (Wipay con bytes de relleno) solo en locales SIN
    //    ninguna pasarela activa: nunca junto a la que ya cobra.
    for (const v of VENUES) {
      const venueId = venues[v.slug]!;
      const active = await tx.gatewayCredential.count({ where: { tenantId: venueId, active: true } });
      if (active > 0) continue;
      const placeholder = Buffer.from(randomUUID());
      await tx.gatewayCredential.create({
        data: {
          tenantId: venueId,
          provider: Provider.WIPAY,
          encKey: placeholder,
          encNonce: placeholder,
          encTag: placeholder,
          kekVersion: 1,
        },
      });
      console.log(`  pasarela de prueba (Wipay) en ${v.slug}`);
    }
  });

  console.log('-'.repeat(60));
  if (created.length === 0) {
    console.log('No se creó ningún usuario (ya existían todos).');
  } else if (generated) {
    console.log(`Usuarios nuevos: ${created.join(', ')}`);
    console.log(`Contraseña (generada ahora, no se vuelve a enseñar): ${password}`);
  } else {
    console.log(`Usuarios nuevos: ${created.join(', ')} — con la contraseña de SEED_PASSWORD`);
  }
  console.log('Cámbiala con `pnpm cli reset-password` si hace falta. Login: POST http://localhost:4100/v1/auth/login');
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
