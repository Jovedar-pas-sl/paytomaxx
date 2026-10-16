import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { GoogleWalletApiError, GoogleWalletClient, WALLET_API_URL, type FetchFn } from './google-wallet-client';
import { GOOGLE_OAUTH_TOKEN_URL } from './google-wallet-jwt';
import { genericClass, genericObject, revokedObjectPatch } from './google-wallet-pass';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SIGNER = { serviceAccountEmail: 'wallet@oxiopay.iam.gserviceaccount.com', privateKey, privateKeyId: null };
const CLASS_ID = '3388000000012345678.oxiopay_saldo';
const OBJECT_ID = `${CLASS_ID}-0123456789abcdef0123456789abcdef01234567`;
const OBJECT = genericObject({
  objectId: OBJECT_ID,
  classId: CLASS_ID,
  brand: 'OxioPay',
  walletUrl: 'https://api.paytomaxx.com/w/tok',
  wallet: { balanceCents: 1_000, status: 'ACTIVE', merged: false, venueName: 'Luna' },
});

interface Call {
  url: string;
  method: string;
  auth: string | undefined;
  body: string;
}

/**
 * fetch de mentira: el token de Google y luego, por cada llamada a la API, la
 * respuesta que toque de la lista (status y cuerpo).
 */
function fakeGoogle(apiReplies: Array<[number, unknown?]>, tokenReplies: Array<[number, unknown]> = []) {
  const calls: Call[] = [];
  let tokenN = 0;
  const fetchFn = vi.fn<FetchFn>(async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: String(init.method), auth: headers.Authorization, body: String(init.body ?? '') });
    if (url === GOOGLE_OAUTH_TOKEN_URL) {
      tokenN += 1;
      const [status, body] = tokenReplies.shift() ?? [200, { access_token: `tok-${tokenN}`, expires_in: 3600, token_type: 'Bearer' }];
      return new Response(JSON.stringify(body), { status });
    }
    const [status, body] = apiReplies.shift() ?? [200, {}];
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  const tokenCalls = () => calls.filter((c) => c.url === GOOGLE_OAUTH_TOKEN_URL);
  const apiCalls = () => calls.filter((c) => c.url !== GOOGLE_OAUTH_TOKEN_URL).map((c) => `${c.method} ${c.url.slice(WALLET_API_URL.length)}`);
  return { fetchFn, calls, tokenCalls, apiCalls };
}

describe('token de acceso (OAuth2 jwt-bearer)', () => {
  it('pide el token con la aserción firmada y lo usa como Bearer', async () => {
    const g = fakeGoogle([[200, {}]]);
    await new GoogleWalletClient(SIGNER, g.fetchFn).patchObject(OBJECT_ID, revokedObjectPatch());
    const [tokenCall] = g.tokenCalls();
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = (form.get('assertion') ?? '').split('.');
    expect(verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(g.calls[1].auth).toBe('Bearer tok-1');
  });

  it('se guarda hasta poco antes de caducar; caducado, se pide otro', async () => {
    let now = 1_000_000;
    const g = fakeGoogle([]);
    const client = new GoogleWalletClient(SIGNER, g.fetchFn, () => now);
    expect(await client.accessToken()).toBe('tok-1');
    now += 30 * 60 * 1000; // media hora: sigue valiendo
    expect(await client.accessToken()).toBe('tok-1');
    now += 29 * 60 * 1000 + 1; // a menos de 1 min de caducar: uno nuevo
    expect(await client.accessToken()).toBe('tok-2');
    expect(g.tokenCalls()).toHaveLength(2);
  });

  it('varias llamadas a la vez piden un solo token', async () => {
    const g = fakeGoogle([]);
    const client = new GoogleWalletClient(SIGNER, g.fetchFn);
    const tokens = await Promise.all([client.accessToken(), client.accessToken(), client.accessToken()]);
    expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(g.tokenCalls()).toHaveLength(1);
  });

  it('Google no da el token → error claro, sin la aserción ni la clave', async () => {
    const g = fakeGoogle([], [[400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }]]);
    const client = new GoogleWalletClient(SIGNER, g.fetchFn);
    const err = await client.accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleWalletApiError);
    expect((err as Error).message).toContain('invalid_grant: Invalid JWT Signature.');
    expect((err as Error).message).not.toMatch(/eyJ|PRIVATE/);
    // Tras el fallo se puede volver a intentar.
    await expect(client.accessToken()).resolves.toBe('tok-2');
  });

  it('401 de la API (token revocado) → token nuevo y un reintento', async () => {
    const g = fakeGoogle([[401, { error: { message: 'Invalid Credentials' } }], [200, {}]]);
    await new GoogleWalletClient(SIGNER, g.fetchFn).patchObject(OBJECT_ID, revokedObjectPatch());
    expect(g.tokenCalls()).toHaveLength(2);
    expect(g.calls.filter((c) => c.url !== GOOGLE_OAUTH_TOKEN_URL).map((c) => c.auth)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });
});

describe('clase', () => {
  it('se crea; si ya existe (409) se pone al día; una vez por proceso', async () => {
    const g = fakeGoogle([[409, { error: { message: 'Resource already exists' } }], [200, {}]]);
    const client = new GoogleWalletClient(SIGNER, g.fetchFn);
    await client.ensureClass(genericClass(CLASS_ID));
    await client.ensureClass(genericClass(CLASS_ID));
    expect(g.apiCalls()).toEqual(['POST /genericClass', `PATCH /genericClass/${CLASS_ID}`]);
  });

  it('si falla, no se da por hecha (se reintenta la próxima vez)', async () => {
    const g = fakeGoogle([[500, { error: { message: 'boom' } }], [200, {}]]);
    const client = new GoogleWalletClient(SIGNER, g.fetchFn);
    await expect(client.ensureClass(genericClass(CLASS_ID))).rejects.toThrow(/crear la clase \(500 boom\)/);
    await client.ensureClass(genericClass(CLASS_ID));
    expect(g.apiCalls()).toEqual(['POST /genericClass', 'POST /genericClass']);
  });
});

describe('objeto (el pase)', () => {
  it('al pulsar «Añadir»: se crea', async () => {
    const g = fakeGoogle([[200, { id: OBJECT_ID }]]);
    await expect(new GoogleWalletClient(SIGNER, g.fetchFn).saveObject(OBJECT)).resolves.toBe('created');
    expect(g.apiCalls()).toEqual(['POST /genericObject']);
    expect(JSON.parse(g.calls[1].body)).toEqual(OBJECT);
  });

  it('al pulsar otra vez: ya existe (409) → se pone al día con PATCH', async () => {
    const g = fakeGoogle([[409, { error: { message: 'exists' } }], [200, {}]]);
    await expect(new GoogleWalletClient(SIGNER, g.fetchFn).saveObject(OBJECT)).resolves.toBe('updated');
    expect(g.apiCalls()).toEqual(['POST /genericObject', `PATCH /genericObject/${OBJECT_ID}`]);
  });

  it('repaso: PATCH; si en Google no existe (404) → se crea', async () => {
    const g = fakeGoogle([[404, { error: { message: 'not found' } }], [200, {}]]);
    await expect(new GoogleWalletClient(SIGNER, g.fetchFn).syncObject(OBJECT)).resolves.toBe('created');
    expect(g.apiCalls()).toEqual([`PATCH /genericObject/${OBJECT_ID}`, 'POST /genericObject']);
  });

  it('repaso: 404 y al crearlo ya existe (409, carrera) → PATCH otra vez', async () => {
    const g = fakeGoogle([[404], [409], [200, {}]]);
    await expect(new GoogleWalletClient(SIGNER, g.fetchFn).syncObject(OBJECT)).resolves.toBe('updated');
    expect(g.apiCalls()).toEqual([`PATCH /genericObject/${OBJECT_ID}`, 'POST /genericObject', `PATCH /genericObject/${OBJECT_ID}`]);
  });

  it('repaso normal: un PATCH y ya', async () => {
    const g = fakeGoogle([[200, {}]]);
    await expect(new GoogleWalletClient(SIGNER, g.fetchFn).syncObject(OBJECT)).resolves.toBe('updated');
    expect(g.apiCalls()).toEqual([`PATCH /genericObject/${OBJECT_ID}`]);
  });

  it('apagar un pase que Google no tiene → "missing", sin error', async () => {
    const g = fakeGoogle([[404]]);
    await expect(new GoogleWalletClient(SIGNER, g.fetchFn).patchObject(OBJECT_ID, revokedObjectPatch())).resolves.toBe('missing');
  });

  it('otros errores (400, 500…) → GoogleWalletApiError con el estado y el mensaje de Google', async () => {
    const g = fakeGoogle([[400, { error: { code: 400, message: 'Invalid barcode' } }]]);
    const err = await new GoogleWalletClient(SIGNER, g.fetchFn).syncObject(OBJECT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleWalletApiError);
    expect((err as GoogleWalletApiError).status).toBe(400);
    expect((err as Error).message).toBe('Google Wallet: no se pudo actualizar el pase (400 Invalid barcode)');
  });

  it('si Google repite en el error el enlace del saldo (el QR), el token no llega al log', async () => {
    const g = fakeGoogle([[400, { error: { message: 'Invalid uri https://api.paytomaxx.com/w/SECRETO-del-saldo in barcode' } }]]);
    const err = await new GoogleWalletClient(SIGNER, g.fetchFn).syncObject(OBJECT).catch((e: unknown) => e);
    expect((err as Error).message).toContain('https://api.paytomaxx.com/w/***');
    expect((err as Error).message).not.toContain('SECRETO');
  });
});
