// Cliente del API del personal (panel, chica, TPV). El refresh token vive en
// una cookie HttpOnly del API (las apps no lo ven); el access token, solo en
// la memoria de cada pestaña. En localStorage solo queda quién es la sesión
// (para pintar la pantalla), nunca un token.

import { ServerUnavailableError, SessionExpiredError, unavailableReason, type UnavailableReason } from './errors';
import { tokenClaims, tokenExpiresSoon, type TokenClaims } from './jwt';
import { browserStorage, createLocalStore } from './local-store';
import { readApiError } from './problem';
import { LOGOUT_TIMEOUT_MS, REQUEST_TIMEOUT_MS, sendRequest } from './request';
import { browserChannel, createTabChannel, type TabMessage } from './tab-channel';
import {
  DEFAULT_MESSAGES,
  SESSION_EXPIRED_EVENT,
  STAFF_CLIENT_HEADER,
  STAFF_CLIENT_VALUE,
  type ApiClient,
  type ApiClientConfig,
  type ApiClientEnv,
  type ApiMessages,
  type CallOptions,
  type LockManagerLike,
  type LoginInput,
  type LoginResult,
  type LoginTotpSetup,
  type SessionEvent,
  type SessionUser,
} from './types';

interface Identity {
  readonly id: string;
  readonly tenantId: string;
}

const defaultEnv: ApiClientEnv = {
  fetch: (input, init) => fetch(input, init),
  storage: browserStorage,
  locks: () => (typeof navigator !== 'undefined' ? (navigator.locks as LockManagerLike | undefined) : undefined),
  channel: browserChannel,
  dispatch: (type) => {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(type));
  },
  now: () => Date.now(),
};

function identityOf(user: Pick<SessionUser, 'id' | 'tenantId'>): Identity {
  return { id: user.id, tenantId: user.tenantId };
}

/** Quién es, sacado del token (sesión que venía de una versión antigua sin esa pista guardada). */
function userFromClaims(claims: TokenClaims): SessionUser | null {
  const { sub, email, role, tenantId, venueSlug } = claims;
  if (!sub || !email || !role || !tenantId || !venueSlug) return null;
  return { id: sub, email, role, tenantId, venueSlug };
}

export function createApiClient<U extends SessionUser = SessionUser>(config: ApiClientConfig): ApiClient<U> {
  const env: ApiClientEnv = { ...defaultEnv, ...config.env };
  const messages: ApiMessages = { ...DEFAULT_MESSAGES, ...config.messages };
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const requestTimeoutMs = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const logoutTimeoutMs = config.logoutTimeoutMs ?? LOGOUT_TIMEOUT_MS;
  const prefix = config.storagePrefix;
  const USER_KEY = `${prefix}_user`;
  /** Lo que guardaban las versiones antiguas (tokens incluidos): se pasa a la cookie y se borra. */
  const LEGACY_REFRESH_KEY = `${prefix}_refresh`;
  const LEGACY_KEYS = [`${prefix}_token`, LEGACY_REFRESH_KEY, `${prefix}_logout`];
  const LOCK_NAME = `${prefix}_refresh:lock`;
  const store = createLocalStore(env.storage);
  const channel = createTabChannel(`${prefix}:session`, env.channel);
  const listeners = new Set<(event: SessionEvent) => void>();

  /** Solo en memoria: nunca se escribe en ningún almacenamiento ni sale por el canal. */
  let accessToken: string | null = null;
  /** Quién es la sesión que enseña esta pestaña (undefined: aún no se ha mirado). */
  let identity: Identity | null | undefined;
  /** Sube al entrar, salir o caducar: lo que vuelva tarde de la sesión anterior no la resucita. */
  let epoch = 0;
  /** Último login o refresco bueno de esta pestaña (ms); 0 = aún ninguno. */
  let lastSessionAt = 0;
  let refreshing: Promise<string> | null = null;
  /** Mientras se sale a propósito, una sesión que ya estaba caducada no es "caducada". */
  let loggingOut = false;

  const url = (path: string): string => `${baseUrl}${path}`;

  function send(path: string, init: RequestInit, timeoutMs = requestTimeoutMs): Promise<Response> {
    return sendRequest(env.fetch, url(path), init, timeoutMs, messages);
  }

  /** POST con la cookie y la cabecera propia (lo que el API exige para usarla). */
  function cookiePost(path: string, body: unknown, timeoutMs = requestTimeoutMs): Promise<Response> {
    return send(
      path,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', [STAFF_CLIENT_HEADER]: STAFF_CLIENT_VALUE },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  }

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = env.locks();
    return locks ? (locks.request(LOCK_NAME, fn) as Promise<T>) : fn();
  }

  function emit(event: SessionEvent): void {
    for (const l of [...listeners]) l(event);
  }

  function getUser(): U | null {
    const raw = store.get(USER_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as U) : null;
    } catch {
      return null;
    }
  }

  function currentIdentity(): Identity | null {
    if (identity === undefined) {
      const user = getUser();
      identity = user ? identityOf(user) : null;
    }
    return identity;
  }

  /** Olvida la sesión en esta pestaña (memoria). */
  function dropLocal(): void {
    epoch += 1;
    accessToken = null;
    identity = null;
  }

  function clearSession(): void {
    dropLocal();
    store.remove(USER_KEY, ...LEGACY_KEYS, ...(config.extraKeys ?? []));
  }

  /**
   * La sesión murió en esta pestaña: se borra y se avisa a la página. Si fue
   * el API quien rechazó el refresco ('shared'), la cookie no vale para nadie:
   * se avisa también a las otras pestañas.
   */
  function expire(scope: 'shared' | 'local', at: number): SessionExpiredError {
    clearSession();
    if (scope === 'shared') channel.post({ type: 'expired', at });
    if (!loggingOut) {
      env.dispatch(SESSION_EXPIRED_EVENT);
      emit({ type: 'expired', source: 'this-tab' });
    }
    return new SessionExpiredError(messages.sessionExpired);
  }

  function messageFor(reason: UnavailableReason): string {
    if (messages.renewFailed) return messages.renewFailed;
    if (reason === 'timeout') return messages.timeout;
    if (reason === 'too-many') return messages.tooMany;
    return reason === 'network' ? messages.network : messages.server;
  }

  function renewFailed(status: number, reason: UnavailableReason): ServerUnavailableError {
    return new ServerUnavailableError(messageFor(reason), status, reason);
  }

  /** Token nuevo de esta pestaña. Si es de otra persona (entró otra en otra pestaña), se avisa. */
  function adoptRefreshed(token: string): void {
    accessToken = token;
    lastSessionAt = env.now();
    const claims = tokenClaims(token);
    if (!claims?.sub) return;
    const fromToken = userFromClaims(claims);
    if (!getUser() && fromToken) store.set(USER_KEY, JSON.stringify(fromToken));
    const mine = currentIdentity();
    if (!mine) {
      identity = { id: claims.sub, tenantId: claims.tenantId ?? '' };
    } else if (mine.id !== claims.sub) {
      identity = { id: claims.sub, tenantId: claims.tenantId ?? '' };
      emit({ type: 'changed', source: 'this-tab' });
    }
  }

  async function postRefresh(legacy: string | null): Promise<Response> {
    try {
      return await cookiePost('/v1/auth/refresh', legacy ? { refreshToken: legacy } : {});
    } catch (err) {
      if (err instanceof ServerUnavailableError) throw renewFailed(0, err.reason);
      throw err;
    }
  }

  async function readAccessToken(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { accessToken?: unknown };
      if (typeof body.accessToken === 'string' && body.accessToken) return body.accessToken;
    } catch {
      // Abajo.
    }
    throw renewFailed(res.status, 'server');
  }

  /** Mientras se esperaba (el candado o la respuesta) se entró o se salió en esta pestaña: manda eso. */
  function settledMeanwhile(): string {
    if (accessToken) return accessToken;
    throw new SessionExpiredError(messages.sessionExpired);
  }

  async function doRefresh(failed: string | null, startEpoch: number): Promise<string> {
    if (epoch !== startEpoch) return settledMeanwhile();
    // Otra petición de esta pestaña ya lo renovó mientras esperábamos: vale ese.
    if (accessToken && accessToken !== failed) return accessToken;
    const at = env.now();
    // La sesión que guardaba la versión antigua (solo en el primer refresco de la pestaña).
    const legacy = lastSessionAt === 0 ? store.get(LEGACY_REFRESH_KEY) : null;
    const res = await postRefresh(legacy);
    if (epoch !== startEpoch) return settledMeanwhile();
    // Solo un "no" del API cierra la sesión; un 429 o un 5xx (p. ej. mientras se despliega) no echa a nadie.
    if (res.status === 401 || res.status === 403) throw expire('shared', at);
    if (!res.ok) throw renewFailed(res.status, unavailableReason(res.status));
    const token = await readAccessToken(res);
    if (legacy) store.remove(...LEGACY_KEYS); // ya está en la cookie
    adoptRefreshed(token);
    return token;
  }

  function refreshAccessToken(failed: string | null = accessToken): Promise<string> {
    const startEpoch = epoch;
    refreshing ??= withLock(() => doRefresh(failed, startEpoch))
      .then((token) => (config.afterRefresh ? config.afterRefresh(token) : token))
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  function hasSession(): boolean {
    currentIdentity();
    return accessToken !== null || store.get(USER_KEY) !== null || store.get(LEGACY_REFRESH_KEY) !== null;
  }

  function ensureAccessToken(): Promise<string> {
    if (accessToken) return Promise.resolve(accessToken);
    if (!hasSession()) return Promise.reject(expire('local', env.now()));
    return refreshAccessToken(null);
  }

  function fetchWithToken(path: string, init: RequestInit, token: string, opts: CallOptions = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return send(path, { ...init, headers, credentials: 'include' }, opts.timeoutMs ?? requestTimeoutMs);
  }

  async function authedFetch(path: string, init: RequestInit = {}, opts: CallOptions = {}): Promise<Response> {
    const token = await ensureAccessToken();
    const res = await fetchWithToken(path, init, token, opts);
    if (res.status !== 401) return res;
    // Caducada de verdad → SessionExpiredError; servidor caído → ServerUnavailableError.
    const renewed = await refreshAccessToken(token);
    const retry = await fetchWithToken(path, init, renewed, opts);
    if (retry.status === 401) throw expire('local', env.now());
    return retry;
  }

  async function freshAccessToken(): Promise<string | null> {
    const token = accessToken;
    if (token && !tokenExpiresSoon(token, env.now())) return token;
    if (!token && !hasSession()) return null;
    try {
      return await refreshAccessToken(token);
    } catch {
      return accessToken;
    }
  }

  function setSession(login: LoginResult<U>): void {
    epoch += 1;
    accessToken = login.accessToken;
    lastSessionAt = env.now();
    store.set(USER_KEY, JSON.stringify(login.user));
    store.remove(...LEGACY_KEYS); // la sesión antigua ya no hace falta: el login puso la cookie
    identity = identityOf(login.user);
    channel.post({ type: 'session', ...identity });
  }

  function updateUser(user: U): void {
    store.set(USER_KEY, JSON.stringify(user));
    identity = identityOf(user);
    channel.post({ type: 'session', ...identity });
  }

  async function login(input: LoginInput): Promise<LoginResult<U>> {
    return openSession('/v1/auth/login', input);
  }

  /** Segundo paso del login con 2FA (tras LoginCodeRequiredError): el ticket y el código. */
  async function loginWithCode(loginTicket: string, totpCode: string): Promise<LoginResult<U>> {
    return openSession('/v1/auth/login/totp', { loginTicket, totpCode });
  }

  /** Super-admin sin 2FA (tras LoginSetupRequiredError): el QR para activarla. No abre sesión. */
  async function loginTotpSetup(loginTicket: string): Promise<LoginTotpSetup> {
    const res = await cookiePost('/v1/auth/login/totp/setup', { loginTicket });
    if (!res.ok) throw await readApiError(res);
    return (await res.json()) as LoginTotpSetup;
  }

  /** Super-admin sin 2FA: el ticket y un código del QR la activan y abren la sesión. */
  async function loginWithNewCode(loginTicket: string, totpCode: string): Promise<LoginResult<U>> {
    return openSession('/v1/auth/login/totp/enroll', { loginTicket, totpCode });
  }

  async function openSession(path: string, payload: unknown): Promise<LoginResult<U>> {
    // Con el candado: un refresco de otra pestaña no pisa la cookie que pone este login.
    const res = await withLock(() => cookiePost(path, payload));
    if (!res.ok) throw await readApiError(res);
    const body = (await res.json()) as LoginResult<U> & { refreshToken?: unknown };
    return {
      accessToken: body.accessToken,
      expiresIn: body.expiresIn,
      refreshExpiresIn: body.refreshExpiresIn,
      user: body.user,
    };
  }

  async function logout(): Promise<boolean> {
    const legacy = store.get(LEGACY_REFRESH_KEY);
    loggingOut = true;
    clearSession();
    channel.post({ type: 'logout' });
    try {
      const res = await cookiePost('/v1/auth/logout', legacy ? { refreshToken: legacy } : {}, logoutTimeoutMs);
      return res.ok;
    } catch {
      // Sin red: aquí ya no queda sesión; la cookie caduca sola.
      return false;
    } finally {
      loggingOut = false;
    }
  }

  async function discardLogin(): Promise<void> {
    try {
      await cookiePost('/v1/auth/logout', {}, logoutTimeoutMs);
    } catch {
      // Es limpieza: si falla, caduca sola.
    }
  }

  /** Otra pestaña entró o cambió de local. */
  function onOtherSession(next: Identity): void {
    if (identity === undefined) {
      identity = next; // esta pestaña aún no enseña ninguna sesión
      return;
    }
    if (identity && identity.id === next.id && identity.tenantId === next.tenantId) return;
    const wasSignedOut = identity === null && accessToken === null;
    dropLocal();
    identity = next;
    emit({ type: wasSignedOut ? 'signed-in' : 'changed', source: 'other-tab' });
  }

  function onTabMessage(message: TabMessage): void {
    if (message.type === 'session') return onOtherSession({ id: message.id, tenantId: message.tenantId });
    if (accessToken === null && currentIdentity() === null) return; // aquí no había sesión
    // Esta pestaña entró o refrescó después del refresco rechazado allí: su sesión es otra.
    if (message.type === 'expired' && lastSessionAt > message.at) return;
    dropLocal();
    emit({ type: message.type, source: 'other-tab' });
  }

  let subscribed = false;
  function onSessionEvent(listener: (event: SessionEvent) => void): () => void {
    if (!subscribed) {
      subscribed = true;
      channel.subscribe(onTabMessage);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    baseUrl,
    messages,
    getAccessToken: () => accessToken,
    setAccessToken: (token) => {
      accessToken = token;
    },
    getUser,
    updateUser,
    hasSession,
    setSession,
    clearSession,
    login,
    loginWithCode,
    loginTotpSetup,
    loginWithNewCode,
    logout,
    discardLogin,
    refreshAccessToken,
    freshAccessToken,
    authedFetch,
    fetchWithToken,
    publicFetch: (path, init = {}, opts = {}) => send(path, init, opts.timeoutMs ?? requestTimeoutMs),
    onSessionEvent,
  };
}

