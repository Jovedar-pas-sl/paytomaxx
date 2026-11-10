// Llaves de acceso (WebAuthn) en el navegador de las apps del personal: el
// API habla en JSON con base64url y el navegador en bytes. Lo mismo que hace
// passkey-browser.ts en las páginas del cliente, en TypeScript para el panel y
// la app del personal. El móvil decide cómo se desbloquea (Face ID, huella o
// su PIN): aquí solo se le pasa el reto y se devuelve lo que firmó.

/** Lo que manda el API para dar de alta una llave (PublicKeyCredentialCreationOptionsJSON). */
export interface CreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: 'public-key'; transports?: string[] }>;
  authenticatorSelection?: Record<string, unknown>;
  attestation?: string;
  extensions?: Record<string, unknown>;
  hints?: string[];
}

/** Lo que manda el API para verificarse (PublicKeyCredentialRequestOptionsJSON). */
export interface RequestOptionsJSON {
  challenge: string;
  rpId?: string;
  timeout?: number;
  allowCredentials?: Array<{ id: string; type: 'public-key'; transports?: string[] }>;
  userVerification?: string;
  extensions?: Record<string, unknown>;
  hints?: string[];
}

/** Lo que espera el API de vuelta (RegistrationResponseJSON / AuthenticationResponseJSON). */
export type CredentialJSON = Record<string, unknown> & { id: string; rawId: string; type: string };

export function b64uToBytes(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function bytesToB64u(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const credentialDescriptor = (c: { id: string; type: 'public-key'; transports?: string[] }) => ({
  id: b64uToBytes(c.id),
  type: c.type,
  ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
});

/** Las opciones del alta, en bytes para navigator.credentials.create. */
export function creationOptionsFromJSON(o: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    ...(o as unknown as PublicKeyCredentialCreationOptions),
    challenge: b64uToBytes(o.challenge),
    user: { ...o.user, id: b64uToBytes(o.user.id) },
    excludeCredentials: (o.excludeCredentials ?? []).map(credentialDescriptor),
  };
}

/** Las opciones para verificarse, en bytes para navigator.credentials.get. */
export function requestOptionsFromJSON(o: RequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    ...(o as unknown as PublicKeyCredentialRequestOptions),
    challenge: b64uToBytes(o.challenge),
    allowCredentials: (o.allowCredentials ?? []).map(credentialDescriptor),
  };
}

interface CredentialLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
    getTransports?: () => string[];
  };
  getClientExtensionResults?: () => Record<string, unknown>;
}

/** Lo que firmó el móvil, en JSON para el API (el alta o la verificación). */
export function credentialToJSON(c: CredentialLike): CredentialJSON {
  const r = c.response;
  const response: Record<string, unknown> = { clientDataJSON: bytesToB64u(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bytesToB64u(r.attestationObject);
    response.transports = r.getTransports ? r.getTransports() : [];
  }
  if (r.authenticatorData) response.authenticatorData = bytesToB64u(r.authenticatorData);
  if (r.signature) response.signature = bytesToB64u(r.signature);
  if (r.userHandle) response.userHandle = bytesToB64u(r.userHandle);
  return {
    id: c.id,
    rawId: bytesToB64u(c.rawId),
    type: c.type,
    response,
    ...(c.authenticatorAttachment ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
    clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
  };
}

/** Lo justo de navigator.credentials (para probarlo sin navegador). */
export interface CredentialsLike {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}

/** ¿Este navegador sabe de llaves de acceso? */
export function passkeysSupported(win: { PublicKeyCredential?: unknown; navigator?: { credentials?: unknown } } = globalThis as never): boolean {
  return Boolean(win.PublicKeyCredential && win.navigator?.credentials);
}

/** El móvil cancela (o tarda y el navegador corta): NotAllowedError / AbortError. */
export function passkeyCancelled(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/** Dar de alta: el móvil crea la llave (pide desbloquearlo) y se devuelve para el API. */
export async function createPasskey(options: CreationOptionsJSON, credentials: CredentialsLike = navigator.credentials): Promise<CredentialJSON> {
  const cred = await credentials.create({ publicKey: creationOptionsFromJSON(options) });
  if (!cred) throw Object.assign(new Error('No se ha creado la llave'), { name: 'NotAllowedError' });
  return credentialToJSON(cred as unknown as CredentialLike);
}

/** Verificarse: el móvil firma el reto con una de las llaves permitidas. */
export async function getPasskey(options: RequestOptionsJSON, credentials: CredentialsLike = navigator.credentials): Promise<CredentialJSON> {
  const cred = await credentials.get({ publicKey: requestOptionsFromJSON(options) });
  if (!cred) throw Object.assign(new Error('No se ha confirmado'), { name: 'NotAllowedError' });
  return credentialToJSON(cred as unknown as CredentialLike);
}
