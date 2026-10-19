// Errores tipados del cliente del API. Las pantallas los distinguen para
// saber qué hacer: volver a entrar (SessionExpiredError), esperar y reintentar
// sin echar a nadie (ServerUnavailableError) o pedir el código 2FA (TotpError).

/** Error de una llamada al API: el mensaje para enseñar, el código HTTP (0 = sin respuesta) y el código de máquina. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  /** Código de error de máquina si el API lo manda (p. ej. "DUPLICATE_REFUND"). */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** El API dijo que no (refresh rechazado) o ya no hay sesión: hay que volver a entrar. */
export class SessionExpiredError extends ApiError {
  override name = 'SessionExpiredError';

  constructor(message: string) {
    super(message, 401);
  }
}

/** Por qué no se pudo hablar con el API. */
export type UnavailableReason = 'network' | 'timeout' | 'too-many' | 'server';

/**
 * Sin red, tiempo agotado, servidor caído o saturado (5xx, 429): la sesión
 * sigue y se reintenta. Nunca cierra la sesión.
 */
export class ServerUnavailableError extends ApiError {
  override name = 'ServerUnavailableError';
  readonly reason: UnavailableReason;

  constructor(message: string, status = 0, reason: UnavailableReason = 'network') {
    super(message, status);
    this.reason = reason;
  }
}

/** Códigos de los errores de 2FA del API. */
export const TOTP_ERROR_CODES = [
  'TOTP_REQUIRED',
  'TOTP_NOT_ENROLLED',
  'TOTP_INVALID',
  'TOTP_LOCKED',
  'TOTP_UNREADABLE',
] as const;
export type TotpErrorCode = (typeof TOTP_ERROR_CODES)[number];

export function isTotpErrorCode(code: unknown): code is TotpErrorCode {
  return typeof code === 'string' && (TOTP_ERROR_CODES as readonly string[]).includes(code);
}

/** Error de 2FA del API (código TOTP_*): pedir el código, esperar al bloqueo o volver a darla de alta. */
export class TotpError extends ApiError {
  override name = 'TotpError';
  declare readonly code: TotpErrorCode;

  constructor(message: string, status: number, code: TotpErrorCode) {
    super(message, status, code);
  }
}

/**
 * Login del super-admin con 2FA: la contraseña es buena y falta el código.
 * Con `loginTicket` (5 min, un solo uso) y el código se abre la sesión
 * (ApiClient.loginWithCode).
 */
export class LoginCodeRequiredError extends TotpError {
  override name = 'LoginCodeRequiredError';
  readonly loginTicket: string;
  /** Segundos que vale el ticket. */
  readonly expiresIn: number;

  constructor(message: string, status: number, loginTicket: string, expiresIn: number) {
    super(message, status, 'TOTP_REQUIRED');
    this.loginTicket = loginTicket;
    this.expiresIn = expiresIn;
  }
}

/**
 * Login de un super-admin SIN 2FA (es obligatoria): la contraseña es buena
 * pero antes hay que activarla. Con `loginTicket` (10 min) se pide el QR
 * (ApiClient.loginTotpSetup) y con su código se activa y se entra
 * (ApiClient.loginWithNewCode).
 */
export class LoginSetupRequiredError extends ApiError {
  override name = 'LoginSetupRequiredError';
  readonly loginTicket: string;
  /** Segundos que vale el ticket. */
  readonly expiresIn: number;

  constructor(message: string, status: number, loginTicket: string, expiresIn: number) {
    super(message, status, 'TOTP_SETUP_REQUIRED');
    this.loginTicket = loginTicket;
    this.expiresIn = expiresIn;
  }
}

/** 429 o 5xx: pasajero, se reintenta (no es culpa de la sesión). */
export function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Motivo de un código HTTP que no deja hablar con el API. */
export function unavailableReason(status: number): UnavailableReason {
  return status === 429 ? 'too-many' : 'server';
}
