import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Un móvil de software con su llave de Face ID (ES256): hace lo mismo que un
 * iPhone o un Android al activarla (register) y al pagar (assert), con la
 * verificación real de @simplewebauthn. Solo para pruebas (unitarias y de
 * integración).
 */

export const ORIGIN = 'https://api.paytomaxx.com';
export const HOST = 'api.paytomaxx.com';
// La llave va al dominio común (vale en api. y en pay.).
export const RP_ID = 'paytomaxx.com';
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
export class SoftAuthenticator {
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
