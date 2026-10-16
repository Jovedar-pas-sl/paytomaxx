import { redactSecretsInText } from '../../../common/logging/redact-url';
import { GOOGLE_OAUTH_TOKEN_URL, oauthAssertion, type JwtSigner } from './google-wallet-jwt';
import type { GenericClass, GenericObject, RevokedPassPatch } from './google-wallet-pass';

/**
 * Cliente mínimo de la API REST de Google Wallet con fetch (sin SDK).
 *  - Token de acceso: OAuth2 con la cuenta de servicio (concesión jwt-bearer),
 *    guardado hasta poco antes de que caduque y compartido entre llamadas a la vez.
 *  - Crear: POST; si ya existe (409), se actualiza con PATCH.
 *  - Actualizar: PATCH; si no existe (404), se crea.
 * Docs: https://developers.google.com/wallet/generic/rest/v1/genericobject/patch
 * Ni el token ni la clave salen en errores ni en logs.
 */

export const WALLET_API_URL = 'https://walletobjects.googleapis.com/walletobjects/v1';
/** Margen: el token se renueva 1 min antes de caducar. */
const TOKEN_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Lo que se copia del mensaje de error de Google (sin cuerpos enteros en el log). */
const MAX_ERROR_CHARS = 200;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class GoogleWalletApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GoogleWalletApiError';
    this.status = status;
  }
}

interface ApiResponse {
  status: number;
  body: unknown;
}

export class GoogleWalletClient {
  private readonly signer: JwtSigner;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;
  private readonly readyClasses = new Set<string>();

  constructor(signer: JwtSigner, fetchFn: FetchFn = (url, init) => fetch(url, init), now: () => number = Date.now) {
    this.signer = signer;
    this.fetchFn = fetchFn;
    this.now = now;
  }

  /** Token de acceso (del caché si aún vale). */
  async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value;
    // Varias llamadas a la vez esperan la misma petición del token.
    this.tokenRequest ??= this.requestToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  /** La clase existe y con nuestros ajustes (una vez por proceso). */
  async ensureClass(cls: GenericClass): Promise<void> {
    if (this.readyClasses.has(cls.id)) return;
    const created = await this.call('POST', '/genericClass', cls);
    if (created.status === 409) {
      expectOk(await this.call('PATCH', `/genericClass/${encodeURIComponent(cls.id)}`, cls), 'actualizar la clase');
    } else {
      expectOk(created, 'crear la clase');
    }
    this.readyClasses.add(cls.id);
  }

  /** Al pulsar «Añadir»: se crea; si ya existía (otro toque), se pone al día. */
  async saveObject(object: GenericObject): Promise<'created' | 'updated'> {
    const created = await this.call('POST', '/genericObject', object);
    if (created.status !== 409) {
      expectOk(created, 'crear el pase');
      return 'created';
    }
    expectOk(await this.call('PATCH', objectPath(object.id), object), 'actualizar el pase');
    return 'updated';
  }

  /** Repaso: se actualiza; si en Google no está (404), se crea. */
  async syncObject(object: GenericObject): Promise<'created' | 'updated'> {
    const patched = await this.call('PATCH', objectPath(object.id), object);
    if (patched.status !== 404) {
      expectOk(patched, 'actualizar el pase');
      return 'updated';
    }
    const created = await this.call('POST', '/genericObject', object);
    if (created.status === 409) {
      // Lo creó otro a la vez: se actualiza.
      expectOk(await this.call('PATCH', objectPath(object.id), object), 'actualizar el pase');
      return 'updated';
    }
    expectOk(created, 'crear el pase');
    return 'created';
  }

  /** Cambia solo unos campos; si el pase no existe en Google, no hay nada que cambiar. */
  async patchObject(objectId: string, patch: RevokedPassPatch): Promise<'updated' | 'missing'> {
    const res = await this.call('PATCH', objectPath(objectId), patch);
    if (res.status === 404) return 'missing';
    expectOk(res, 'apagar el pase');
    return 'updated';
  }

  private async call(method: 'POST' | 'PATCH', path: string, body: unknown, retryAuth = true): Promise<ApiResponse> {
    const token = await this.accessToken();
    const res = await this.fetchFn(`${WALLET_API_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 && retryAuth) {
      // Token revocado o caducado antes de tiempo: uno nuevo y otra vez.
      this.token = null;
      return this.call(method, path, body, false);
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  private async requestToken(): Promise<string> {
    const issuedAt = this.now();
    const res = await this.fetchFn(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: oauthAssertion(this.signer, new Date(issuedAt)),
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
      error_description?: unknown;
    } | null;
    if (!res.ok || typeof body?.access_token !== 'string') {
      const why = [body?.error, body?.error_description].filter((s) => typeof s === 'string').join(': ');
      throw new GoogleWalletApiError(res.status, `Google no dio el token de acceso (${res.status}${why ? ` ${short(why)}` : ''})`);
    }
    const ttlSec = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 0;
    this.token = { value: body.access_token, expiresAt: issuedAt + Math.max(0, ttlSec * 1000 - TOKEN_MARGIN_MS) };
    return body.access_token;
  }
}

function objectPath(objectId: string): string {
  return `/genericObject/${encodeURIComponent(objectId)}`;
}

function expectOk(res: ApiResponse, what: string): void {
  if (res.status >= 200 && res.status < 300) return;
  const message = (res.body as { error?: { message?: unknown } } | null)?.error?.message;
  throw new GoogleWalletApiError(
    res.status,
    `Google Wallet: no se pudo ${what} (${res.status}${typeof message === 'string' ? ` ${short(message)}` : ''})`,
  );
}

/** Recortado y sin enlaces del saldo: Google puede repetir en el error un valor enviado (el QR). */
function short(text: string): string {
  const clean = redactSecretsInText(text);
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}
