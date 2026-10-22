import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { hasWalletViewSession, walletViewSetCookies } from '../../../api/src/modules/wallets/wallet-view-session';

// Transport regression: use Playwright's actual cookie jar, never a manually
// copied Cookie header. Controller authorization has separate Nest HTTP tests.
const secret = 'test-only-wallet-view-cookie-secret-32-characters';
const wallet = { id: 'cookie-transport-wallet', qrToken: 'test-private-wallet-token' };
let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/w/card/test/view') {
      res.setHeader('Set-Cookie', walletViewSetCookies(secret, wallet));
      res.end('{}');
      return;
    }
    // Any other path on the same host: the session cookie must not travel there.
    if (req.url === '/s/some-charge') {
      res.statusCode = req.headers.cookie ? 400 : 200;
      res.end('{}');
      return;
    }
    const target = req.url?.includes('other-wallet') ? { ...wallet, id: 'other' } : wallet;
    res.statusCode = hasWalletViewSession(secret, target, req.headers.cookie) ? 200 : 401;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

test('the path-scoped cookies reach both wallet paths only, and cannot unlock another wallet', async ({ playwright }) => {
  // The test listener uses HTTP; production cookie properties have unit tests.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const client = await playwright.request.newContext();
  try {
    expect((await client.get(`${origin}/v1/wallets/public/${wallet.qrToken}`)).status()).toBe(401);
    expect((await client.post(`${origin}/w/card/test/view`)).status()).toBe(200);
    const storage = await client.storageState();
    expect(storage.cookies).toEqual([
      expect.objectContaining({ path: `/w/${wallet.qrToken}`, httpOnly: true, sameSite: 'Strict' }),
      expect.objectContaining({ path: `/v1/wallets/public/${wallet.qrToken}`, httpOnly: true, sameSite: 'Strict' }),
    ]);
    expect((await client.get(`${origin}/w/${wallet.qrToken}/state`)).status()).toBe(200);
    expect((await client.get(`${origin}/v1/wallets/public/${wallet.qrToken}`)).status()).toBe(200);
    expect((await client.post(`${origin}/w/${wallet.qrToken}/google-wallet`)).status()).toBe(200);
    expect((await client.get(`${origin}/s/some-charge`)).status()).toBe(200);
    expect((await client.get(`${origin}/v1/wallets/public/other-wallet`)).status()).toBe(401);
  } finally {
    await client.dispose();
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});
