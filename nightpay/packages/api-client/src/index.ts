// @nightpay/api-client: lo común de los clientes del API de las apps del
// personal (panel, chica, TPV). Cada app tiene su envoltorio fino (lib/http.ts
// o lib/api.ts) con los nombres de siempre y sus propios endpoints.

export { createApiClient } from './client';
export {
  ApiError,
  ServerUnavailableError,
  SessionExpiredError,
  TOTP_ERROR_CODES,
  TotpError,
  isTotpErrorCode,
  isTransientStatus,
  type TotpErrorCode,
  type UnavailableReason,
} from './errors';
export { tokenClaims, tokenExpiresSoon, type TokenClaims } from './jwt';
export { parseProblemDetails, readApiError, type ProblemInfo } from './problem';
export { LOGOUT_TIMEOUT_MS, REQUEST_TIMEOUT_MS, sendRequest, type FetchLike, type RequestMessages } from './request';
export { parseTabMessage, type BroadcastChannelLike, type ChannelFactory, type TabMessage } from './tab-channel';
export {
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
  type SessionEvent,
  type SessionUser,
} from './types';
