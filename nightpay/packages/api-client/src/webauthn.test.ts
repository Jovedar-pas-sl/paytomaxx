import { describe, expect, it, vi } from 'vitest';
import {
  b64uToBytes,
  bytesToB64u,
  createPasskey,
  credentialToJSON,
  getPasskey,
  passkeyCancelled,
  passkeysSupported,
  requestOptionsFromJSON,
  type CredentialsLike,
} from './webauthn';

const bytes = (...n: number[]) => new Uint8Array(n).buffer;

describe('llaves de acceso en el navegador del personal', () => {
  it('base64url ↔ bytes, sin relleno y con los caracteres de URL', () => {
    const b = bytes(251, 255, 0, 1);
    expect(bytesToB64u(b)).toBe('-_8AAQ');
    expect(new Uint8Array(b64uToBytes('-_8AAQ'))).toEqual(new Uint8Array(b));
  });

  it('las opciones para verificarse: el reto y solo sus llaves, en bytes', () => {
    const o = requestOptionsFromJSON({ challenge: 'AQID', rpId: 'paytomaxx.com', allowCredentials: [{ id: 'BAU', type: 'public-key', transports: ['internal'] }], userVerification: 'required' });
    expect(new Uint8Array(o.challenge as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(o.allowCredentials?.map((c) => [new Uint8Array(c.id as ArrayBuffer)[0], c.transports])).toEqual([[4, ['internal']]]);
    expect(o.userVerification).toBe('required');
  });

  it('lo que firmó el móvil, en JSON para el API', () => {
    const json = credentialToJSON({
      id: 'cred',
      rawId: bytes(1, 2),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: { clientDataJSON: bytes(3), authenticatorData: bytes(4), signature: bytes(5), userHandle: null },
      getClientExtensionResults: () => ({}),
    });
    expect(json).toEqual({
      id: 'cred',
      rawId: 'AQI',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: { clientDataJSON: 'Aw', authenticatorData: 'BA', signature: 'BQ' },
      clientExtensionResults: {},
    });
  });

  it('dar de alta y verificarse pasan por navigator.credentials; cancelar se reconoce', async () => {
    const credential = {
      id: 'cred',
      rawId: bytes(9),
      type: 'public-key',
      response: { clientDataJSON: bytes(1), attestationObject: bytes(2), getTransports: () => ['internal'] },
    };
    const credentials: CredentialsLike = { create: vi.fn(async () => credential as never), get: vi.fn(async () => null) };
    const created = await createPasskey(
      { challenge: 'AQ', rp: { name: 'OxioPay' }, user: { id: 'Ag', name: 'lola@x.es', displayName: 'Lola' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] },
      credentials,
    );
    expect(created.response).toEqual({ clientDataJSON: 'AQ', attestationObject: 'Ag', transports: ['internal'] });
    await expect(getPasskey({ challenge: 'AQ' }, credentials)).rejects.toSatisfy(passkeyCancelled);
    expect(passkeyCancelled({ name: 'AbortError' })).toBe(true);
    expect(passkeyCancelled(new Error('red'))).toBe(false);
  });

  it('sin WebAuthn en el navegador, no se ofrece', () => {
    expect(passkeysSupported({})).toBe(false);
    expect(passkeysSupported({ PublicKeyCredential: function () {}, navigator: { credentials: {} } })).toBe(true);
  });
});
