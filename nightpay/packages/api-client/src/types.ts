import type { FetchLike, RequestMessages } from './request';
import type { ChannelFactory } from './tab-channel';

/** Evento de `window`: la sesión ha muerto en esta pestaña. La página vuelve al login. */
export const SESSION_EXPIRED_EVENT = 'np:session-expired';
/** Cabecera propia de las apps: el API la exige (con el Origin) para usar la cookie. */
export const STAFF_CLIENT_HEADER = 'X-OxioPay-Client';
export const STAFF_CLIENT_VALUE = '1';

export interface ApiMessages extends RequestMessages {
  /** La sesión se acabó: hay que volver a entrar. */
  readonly sessionExpired: string;
  /** El API contesta 5xx. */
  readonly server: string;
  /** El API contesta 429. */
  readonly tooMany: string;
  /** Si está, lo que se dice siempre que no se pudo renovar la sesión por un fallo pasajero. */
  readonly renewFailed?: string;
}

export const DEFAULT_MESSAGES: ApiMessages = {
  sessionExpired: 'Tu sesión ha caducado. Vuelve a entrar.',
  network: 'No se pudo conectar con el servidor. Revisa la conexión y vuelve a probar.',
  timeout: 'El servidor tarda en responder. Vuelve a probar.',
  server: 'El servidor está teniendo problemas. Vuelve a probar en un momento.',
  tooMany: 'Demasiadas peticiones seguidas. Espera un momento y vuelve a probar.',
};

/** Quién es la sesión (lo que devuelve el login). No es secreto: se guarda para pintar la pantalla. */
export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly tenantId: string;
  readonly venueSlug: string;
  readonly isSuperAdmin?: boolean;
  readonly displayName?: string | null;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly venueSlug?: string;
}

/** Lo que devuelve el login a la app: el access token (solo para la memoria) y quién es. Sin refresh token. */
export interface LoginResult<U extends SessionUser = SessionUser> {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshExpiresIn?: number;
  readonly user: U;
}

/**
 * Lo que pasa con la sesión:
 *   - expired: el API dijo que no (aquí o en otra pestaña);
 *   - logout: se salió en otra pestaña;
 *   - signed-in: otra pestaña entró y esta no tenía sesión;
 *   - changed: otra persona u otro local (entró otra persona en otra pestaña, o el super-admin cambió de local).
 */
export type SessionEvent =
  | { readonly type: 'expired'; readonly source: 'this-tab' | 'other-tab' }
  | { readonly type: 'logout'; readonly source: 'other-tab' }
  | { readonly type: 'signed-in'; readonly source: 'other-tab' }
  | { readonly type: 'changed'; readonly source: 'this-tab' | 'other-tab' };

/** Lo mínimo de navigator.locks que se usa. */
export interface LockManagerLike {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

/** Todo lo de fuera, para poder sustituirlo en las pruebas. */
export interface ApiClientEnv {
  readonly fetch: FetchLike;
  readonly storage: () => Storage | undefined;
  readonly locks: () => LockManagerLike | undefined;
  readonly channel: ChannelFactory;
  /** Lanza un evento en `window` (SESSION_EXPIRED_EVENT). */
  readonly dispatch: (type: string) => void;
  readonly now: () => number;
}

export interface ApiClientConfig {
  readonly baseUrl: string;
  /** Prefijo de las claves de la app en localStorage y del candado y el canal: np_admin, np_op, np_tpv. */
  readonly storagePrefix: string;
  readonly messages?: Partial<ApiMessages>;
  readonly requestTimeoutMs?: number;
  readonly logoutTimeoutMs?: number;
  /** Tras cada refresco: puede cambiar el token (el super-admin vuelve al local que había elegido). */
  readonly afterRefresh?: (accessToken: string) => Promise<string>;
  /** Otras claves no secretas de la app a borrar al cerrar sesión (p. ej. np_tpv_venue). */
  readonly extraKeys?: readonly string[];
  readonly env?: Partial<ApiClientEnv>;
}

export interface CallOptions {
  /** Tiempo máximo hasta la respuesta (por defecto 15 s). */
  readonly timeoutMs?: number;
}

export interface ApiClient<U extends SessionUser = SessionUser> {
  readonly baseUrl: string;
  readonly messages: ApiMessages;
  /** El access token de esta pestaña (solo en memoria); null si aún no se pidió. */
  getAccessToken(): string | null;
  /** Token nuevo sin refrescar (cambio de local del super-admin). */
  setAccessToken(token: string): void;
  /** Quién es la sesión guardada (no secreto); null si no hay. */
  getUser(): U | null;
  /** Cambia quién es (cambio de local): las otras pestañas se enteran. */
  updateUser(user: U): void;
  /** ¿Hay sesión en este dispositivo? (token en memoria, o la sesión guardada: la cookie dirá si sigue viva.) */
  hasSession(): boolean;
  /** Tras entrar: token a la memoria, quién es al almacenamiento y aviso a las otras pestañas. */
  setSession(login: LoginResult<U>): void;
  /** Borra la sesión de este dispositivo (memoria y almacenamiento), sin avisar a nadie. */
  clearSession(): void;
  /** POST /v1/auth/login. Lanza ApiError (status 0 = sin respuesta). No guarda nada: eso es setSession. */
  login(input: LoginInput): Promise<LoginResult<U>>;
  /** Segundo paso del login con 2FA (super-admin): el ticket de LoginCodeRequiredError y el código. */
  loginWithCode(loginTicket: string, totpCode: string): Promise<LoginResult<U>>;
  /** Salir: borra todo aquí al momento, avisa a las otras pestañas y cierra en el API. Devuelve si el API lo confirmó. */
  logout(): Promise<boolean>;
  /** Cierra en el API la sesión de un login que no se va a usar (no toca nada de aquí). */
  discardLogin(): Promise<void>;
  /** Access token nuevo con la cookie: uno a la vez en la pestaña y, con Web Locks, entre pestañas. */
  refreshAccessToken(failed?: string | null): Promise<string>;
  /** Para el socket: el token vigente, renovado si está a punto de caducar; null sin sesión. */
  freshAccessToken(): Promise<string | null>;
  /** fetch con la sesión: pide el token si no lo hay y, con un 401, refresca una vez y repite. */
  authedFetch(path: string, init?: RequestInit, opts?: CallOptions): Promise<Response>;
  /** fetch con un token concreto, sin refrescar. */
  fetchWithToken(path: string, init: RequestInit, token: string, opts?: CallOptions): Promise<Response>;
  /** fetch sin sesión (enlaces públicos), con tiempo máximo. */
  publicFetch(path: string, init?: RequestInit, opts?: CallOptions): Promise<Response>;
  /** Cambios de la sesión (de esta pestaña y de las otras). Devuelve cómo dejar de escuchar. */
  onSessionEvent(listener: (event: SessionEvent) => void): () => void;
}
