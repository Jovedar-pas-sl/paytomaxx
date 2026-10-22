import { createRequire } from 'node:module';

// Deliberately refuses production and arbitrary databases, even with valid credentials.
const target = new URL(process.env.DATABASE_URL ?? 'invalid:');
if (process.env.E2E_ISOLATED !== '1' || !['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/nightpay_e2e' || process.env.NODE_ENV === 'production') {
  throw new Error('E2E seed requires E2E_ISOLATED=1 and a local database named nightpay_e2e');
}
const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const { PrismaClient } = requireApi('@nightpay/db');
const bcrypt = requireApi('bcryptjs');
const prisma = new PrismaClient();
try {
  const passwordHash = await bcrypt.hash('Isolated-test-password-2026!', 4);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.bypass_rls = 'on'");
    // Fresh test database: never update an existing human's account.
    const venue = await tx.venue.create({ data: { name: 'Local de pruebas CI', slug: 'isolated-e2e' } });
    await tx.venueNight.create({ data: { tenantId: venue.id } });
    for (const [role, email] of [['OWNER', 'owner@isolated.test'], ['WAITER', 'waiter@isolated.test']]) {
      await tx.user.create({ data: { tenantId: venue.id, role, email, passwordHash } });
    }
    const wallet = await tx.clientWallet.create({ data: { tenantId: venue.id, qrToken: 'isolated-private-wallet-token', shortCode: 'CITEST', balanceCents: 12345 } });
    await tx.walletCard.create({ data: { token: 'isolated-public-card-token', walletId: wallet.id, venueId: venue.id, status: 'ISSUED' } });
    // A fake public key is sufficient to test that private reads require unlocking.
    // Real passkey cryptography is exercised in its dedicated unit/integration tests.
    await tx.walletPasskey.create({ data: { walletId: wallet.id, credentialId: 'isolated-credential', publicKey: Buffer.from('test-only-public-key') } });
  });
  console.log('Isolated browser fixtures ready');
} finally { await prisma.$disconnect(); }
