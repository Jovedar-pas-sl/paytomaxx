import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ClientDevicesService } from './client-devices.service';

/**
 * Face ID / huella de punta a punta con la verificación real (@simplewebauthn):
 * un "móvil" de software con su clave P-256 hace lo mismo que un iPhone o un
 * Android al registrar la llave y al firmar el reto.
 */

const ORIGIN = 'https://api.paytomaxx.com';
const HOST = 'api.paytomaxx.com';
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

  constructor(private readonly rpID = HOST) {
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

// ─── Base y Redis de mentira (solo lo que toca la parte de Face ID) ─────────
type Key = { deviceId: string; credentialId: string; publicKey: Buffer; counter: bigint; transports: string[] };
function makeService() {
  const keys: Key[] = [];
  const kv = new Map<string, string>();
  const prisma = {
    clientDevicePasskey: {
      findMany: async ({ where }: { where: { deviceId: string } }) => keys.filter((k) => k.deviceId === where.deviceId),
      count: async ({ where }: { where: { deviceId: string } }) => keys.filter((k) => k.deviceId === where.deviceId).length,
      create: async ({ data }: { data: Key }) => {
        if (keys.some((k) => k.credentialId === data.credentialId)) throw new Error('duplicate');
        keys.push({ ...data });
      },
      update: async ({ where, data }: { where: { credentialId: string }; data: { counter: bigint } }) => {
        const k = keys.find((x) => x.credentialId === where.credentialId)!;
        k.counter = data.counter;
      },
    },
  };
  const redis = {
    set: async (k: string, v: string) => {
      kv.set(k, v);
      return 'OK';
    },
    exists: async (k: string) => (kv.has(k) ? 1 : 0),
    del: async (k: string) => (kv.delete(k) ? 1 : 0),
    multi: () => {
      let key = '';
      const chain = {
        get: (k: string) => ((key = k), chain),
        del: () => chain,
        exec: async () => {
          const v = kv.get(key) ?? null;
          kv.delete(key);
          return [
            [null, v],
            [null, v ? 1 : 0],
          ];
        },
      };
      return chain;
    },
  };
  return { svc: new ClientDevicesService(prisma as never, redis as never), keys, kv };
}

const PHONE = 'device-1';
const wallet = { id: 'wallet-1', deviceId: PHONE };

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = ORIGIN;
  delete process.env.NEXT_PUBLIC_WEB_CLIENT_URL;
});

async function protect(svc: ClientDevicesService, phone: SoftAuthenticator): Promise<void> {
  const options = await svc.registrationOptions(wallet, PHONE, HOST);
  await svc.register(wallet, PHONE, HOST, phone.register(options.challenge));
}

describe('Face ID / huella del móvil del cliente', () => {
  it('se activa solo desde el móvil del saldo', async () => {
    const { svc } = makeService();
    await expect(svc.registrationOptions(wallet, 'otro-movil', HOST)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.registrationOptions(wallet, null, HOST)).rejects.toBeInstanceOf(ForbiddenException);
    const options = await svc.registrationOptions(wallet, PHONE, HOST);
    expect(options.rp.id).toBe(HOST);
    expect(options.authenticatorSelection?.userVerification).toBe('required');
  });

  it('una sola llave por móvil: con una ya puesta, no se puede colar otra', async () => {
    const { svc, keys } = makeService();
    await protect(svc, new SoftAuthenticator());
    await expect(svc.registrationOptions(wallet, PHONE, HOST)).rejects.toThrow(/ya está protegido/);
    expect(keys).toHaveLength(1);
  });

  it('activar: guarda la clave pública y el saldo queda protegido', async () => {
    const { svc, keys } = makeService();
    const phone = new SoftAuthenticator();
    await protect(svc, phone);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ deviceId: PHONE, credentialId: b64u(phone.credentialId), transports: ['internal'] });
    expect(await svc.stateFor(wallet, PHONE)).toEqual({ thisPhone: true, otherPhone: false, protected: true });
    expect(await svc.stateFor(wallet, 'otro-movil')).toEqual({ thisPhone: false, otherPhone: true, protected: true });
  });

  it('una respuesta de otra web (phishing) no se acepta al activar', async () => {
    const { svc, keys } = makeService();
    const options = await svc.registrationOptions(wallet, PHONE, HOST);
    const phone = new SoftAuthenticator();
    await expect(
      svc.register(wallet, PHONE, HOST, phone.register(options.challenge, 'https://paytomaxx.evil.example')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(keys).toHaveLength(0);
  });

  it('sin protección, aceptar sigue como siempre', async () => {
    const { svc } = makeService();
    await expect(svc.assertPresence(wallet, HOST, undefined)).resolves.toBeUndefined();
    await expect(svc.assertPresence({ id: 'w2', deviceId: null }, HOST, undefined)).resolves.toBeUndefined();
  });

  it('protegido: sin la cara o el dedo, no; con ellos, sí (y el contador avanza)', async () => {
    const { svc, keys } = makeService();
    const phone = new SoftAuthenticator();
    await protect(svc, phone);

    await expect(svc.assertPresence(wallet, HOST, undefined)).rejects.toBeInstanceOf(ForbiddenException);

    const { challenge } = await svc.challenge(wallet, HOST);
    await expect(svc.assertPresence(wallet, HOST, phone.assert(challenge))).resolves.toBeUndefined();
    expect(keys[0]!.counter).toBe(1n);
  });

  it('la misma firma dos veces (repetir la petición) no vale', async () => {
    const { svc } = makeService();
    const phone = new SoftAuthenticator();
    await protect(svc, phone);
    const { challenge } = await svc.challenge(wallet, HOST);
    const signed = phone.assert(challenge);
    await svc.assertPresence(wallet, HOST, signed);
    await expect(svc.assertPresence(wallet, HOST, signed)).rejects.toBeInstanceOf(ConflictException);
  });

  it('quien solo tiene el enlace no bloquea al dueño: pedir retos o mandar basura no gasta el suyo', async () => {
    const { svc } = makeService();
    const phone = new SoftAuthenticator();
    await protect(svc, phone);
    const { challenge } = await svc.challenge(wallet, HOST); // el del dueño
    // El intruso pide muchos retos y prueba con basura y con su propia llave.
    for (let i = 0; i < 5; i++) await svc.challenge(wallet, HOST);
    await expect(svc.assertPresence(wallet, HOST, { id: 'basura', response: {} })).rejects.toBeInstanceOf(ForbiddenException);
    const theirs = await svc.challenge(wallet, HOST);
    await expect(svc.assertPresence(wallet, HOST, new SoftAuthenticator().assert(theirs.challenge))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Firma rota con la llave buena: tampoco gasta el reto.
    const broken = phone.assert(challenge) as { response: { signature: string } };
    broken.response.signature = Buffer.from('nada').toString('base64url');
    await expect(svc.assertPresence(wallet, HOST, broken)).rejects.toBeInstanceOf(ForbiddenException);
    // El dueño, con su reto, sigue pudiendo.
    await expect(svc.assertPresence(wallet, HOST, phone.assert(challenge))).resolves.toBeUndefined();
  });

  it('firmado en otra web, sin verificar la cara, o con la llave de otro móvil → no', async () => {
    const { svc } = makeService();
    const phone = new SoftAuthenticator();
    await protect(svc, phone);

    let { challenge } = await svc.challenge(wallet, HOST);
    await expect(
      svc.assertPresence(wallet, HOST, phone.assert(challenge, { origin: 'https://evil.example' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    ({ challenge } = await svc.challenge(wallet, HOST));
    await expect(svc.assertPresence(wallet, HOST, phone.assert(challenge, { userVerified: false }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    ({ challenge } = await svc.challenge(wallet, HOST));
    const intruder = new SoftAuthenticator();
    await expect(svc.assertPresence(wallet, HOST, intruder.assert(challenge))).rejects.toThrow(/no es la de este saldo/);
  });
});
