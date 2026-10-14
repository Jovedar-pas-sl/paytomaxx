import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { WalletPasskeysService } from './wallet-passkeys.service';

/**
 * La llave del saldo (Face ID, huella o el PIN del teléfono) de punta a punta
 * con la verificación real (@simplewebauthn): un "móvil" de software con su
 * clave P-256 hace lo mismo que un iPhone o un Android al activarla y al pagar.
 */

const ORIGIN = 'https://api.paytomaxx.com';
const HOST = 'api.paytomaxx.com';
// La llave va al dominio común (vale en api. y en pay.).
const RP_ID = 'paytomaxx.com';
const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('base64url');

// ─── CBOR mínimo (lo que usa WebAuthn: enteros, textos, bytes y mapas) ──────
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
}
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

/** Un móvil con su llave de Face ID (ES256). */
class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject };
  private count = 0;

  constructor(private readonly rpID = RP_ID) {
    this.key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  }

  private rpIdHash(): Buffer {
    return createHash('sha256').update(this.rpID).digest();
  }

  register(challenge: string, origin = ORIGIN): unknown {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2], // EC2
        [3, -7], // ES256
        [-1, 1], // P-256
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
    const authData = Buffer.concat([
      this.rpIdHash(),
      Buffer.from([0x45]), // presente + verificado (cara/huella) + con credencial
      Buffer.alloc(4), // contador 0
      Buffer.alloc(16), // aaguid
      Buffer.from([0, this.credentialId.length]),
      this.credentialId,
      cose,
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  assert(challenge: string, opts: { origin?: string; userVerified?: boolean } = {}): unknown {
    this.count += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.count);
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([opts.userVerified === false ? 0x01 : 0x05]), counter]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: opts.origin ?? ORIGIN, crossOrigin: false }),
    );
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), this.key.privateKey);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
    };
  }
}

// ─── Base y Redis de mentira (solo lo que toca la llave) ─────────────────
type Key = { walletId: string; credentialId: string; publicKey: Buffer; counter: bigint; transports: string[] };
function makeService() {
  const keys: Key[] = [];
  const kv = new Map<string, string>();
  // acrossVenues en serie: hace de "saldo bloqueado" (FOR UPDATE).
  let lock: Promise<unknown> = Promise.resolve();
  const prisma = {
    $queryRaw: async () => [],
    acrossVenues: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const run = lock.then(() => fn(prisma));
      lock = run.catch(() => undefined);
      return run;
    },
    walletPasskey: {
      count: async ({ where }: { where: { walletId: string } }) => keys.filter((k) => k.walletId === where.walletId).length,
      findFirst: async ({ where }: { where: { walletId: string } }) => keys.find((k) => k.walletId === where.walletId) ?? null,
      findUnique: async ({ where }: { where: { credentialId: string } }) => keys.find((k) => k.credentialId === where.credentialId) ?? null,
      create: async ({ data }: { data: Key }) => {
        if (keys.some((k) => k.credentialId === data.credentialId)) throw new Error('duplicate');
        keys.push({ ...data });
      },
      update: async ({ where, data }: { where: { credentialId: string }; data: { counter: bigint } }) => {
        keys.find((x) => x.credentialId === where.credentialId)!.counter = data.counter;
      },
    },
  };
  const redis = {
    set: async (k: string, v: string) => (kv.set(k, v), 'OK'),
    exists: async (k: string) => (kv.has(k) ? 1 : 0),
    del: async (k: string) => (kv.delete(k) ? 1 : 0),
  };
  return { svc: new WalletPasskeysService(prisma as never, redis as never), keys };
}

const WALLET = { id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b', shortCode: 'K7Q4M2' };
const OTHER_WALLET = { id: '11111111-2222-4333-8444-555555555555', shortCode: 'Z9Z9Z9' };

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = ORIGIN;
  delete process.env.NEXT_PUBLIC_WEB_CLIENT_URL;
});

async function activate(svc: WalletPasskeysService, phone: SoftAuthenticator, wallet = WALLET): Promise<void> {
  const options = await svc.registrationOptions(wallet, HOST);
  await svc.register(wallet.id, HOST, phone.register(options.challenge));
}

describe('Face ID del saldo (passkey)', () => {
  it('activar: una llave del móvil para este saldo; la pide con la cara/huella/PIN y sin saber de antemano de quién es', async () => {
    const { svc, keys } = makeService();
    const options = await svc.registrationOptions(WALLET, HOST);
    expect(options.rp.id).toBe(RP_ID);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(options.user.name).toContain('K7Q-4M2');
    await svc.register(WALLET.id, HOST, new SoftAuthenticator().register(options.challenge));
    expect(keys).toHaveLength(1);
    expect(await svc.hasPasskey(WALLET.id)).toBe(true);
  });

  it('una sola llave por saldo; y una respuesta de otra web no activa nada', async () => {
    const { svc, keys } = makeService();
    const options = await svc.registrationOptions(WALLET, HOST);
    await expect(
      svc.register(WALLET.id, HOST, new SoftAuthenticator().register(options.challenge, 'https://evil.example')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await activate(svc, new SoftAuthenticator());
    await expect(svc.registrationOptions(WALLET, HOST)).rejects.toThrow(/ya tiene Face ID/);
    expect(keys).toHaveLength(1);
  });

  it('dos activaciones a la vez (dos móviles): solo queda una llave', async () => {
    const { svc, keys } = makeService();
    const a = await svc.registrationOptions(WALLET, HOST);
    const b = await svc.registrationOptions(WALLET, HOST);
    const res = await Promise.allSettled([
      svc.register(WALLET.id, HOST, new SoftAuthenticator().register(a.challenge)),
      svc.register(WALLET.id, HOST, new SoftAuthenticator().register(b.challenge)),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(keys).toHaveLength(1);
  });

  it('pagar: el reto no dice de quién es; la llave del cliente dice su saldo', async () => {
    const { svc } = makeService();
    const mine = new SoftAuthenticator();
    const theirs = new SoftAuthenticator();
    await activate(svc, mine);
    await activate(svc, theirs, OTHER_WALLET);
    const { challenge, allowCredentials } = await svc.challenge('charge:qr-1', HOST);
    expect(allowCredentials ?? []).toHaveLength(0);
    expect(await svc.verify('charge:qr-1', HOST, mine.assert(challenge))).toBe(WALLET.id);
    const second = await svc.challenge('charge:qr-2', HOST);
    expect(await svc.verify('charge:qr-2', HOST, theirs.assert(second.challenge))).toBe(OTHER_WALLET.id);
  });

  it('el reto vale solo para su cobro, una vez, y solo con la cara/huella/PIN verificados', async () => {
    const { svc } = makeService();
    const phone = new SoftAuthenticator();
    await activate(svc, phone);
    let { challenge } = await svc.challenge('charge:qr-1', HOST);
    // Firmado para el cobro 1, presentado en el cobro 2: no.
    await expect(svc.verify('charge:qr-2', HOST, phone.assert(challenge))).rejects.toBeInstanceOf(ConflictException);
    const signed = phone.assert(challenge);
    await svc.verify('charge:qr-1', HOST, signed);
    await expect(svc.verify('charge:qr-1', HOST, signed)).rejects.toBeInstanceOf(ConflictException);
    ({ challenge } = await svc.challenge('charge:qr-3', HOST));
    await expect(svc.verify('charge:qr-3', HOST, phone.assert(challenge, { userVerified: false }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    ({ challenge } = await svc.challenge('charge:qr-4', HOST));
    await expect(
      svc.verify('charge:qr-4', HOST, phone.assert(challenge, { origin: 'https://evil.example' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una llave que no es de ningún saldo, o basura → no; y no gasta el reto del dueño', async () => {
    const { svc } = makeService();
    const phone = new SoftAuthenticator();
    await activate(svc, phone);
    const { challenge } = await svc.challenge('charge:qr-1', HOST);
    await expect(svc.verify('charge:qr-1', HOST, new SoftAuthenticator().assert(challenge))).rejects.toThrow(/no tiene saldo/);
    await expect(svc.verify('charge:qr-1', HOST, { id: 'x', response: {} })).rejects.toBeInstanceOf(ForbiddenException);
    for (let i = 0; i < 5; i++) await svc.challenge('charge:qr-1', HOST);
    expect(await svc.verify('charge:qr-1', HOST, phone.assert(challenge))).toBe(WALLET.id);
  });
});
