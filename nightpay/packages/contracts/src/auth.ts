import { z } from 'zod';
import { UuidSchema } from './common';

export const RoleSchema = z.enum(['OWNER', 'MANAGER', 'WAITER', 'OPERATOR']);
export type Role = z.infer<typeof RoleSchema>;

export const LoginRequestSchema = z.object({
  // 254 = máximo de un email (RFC 5321); también acota lo que llega a los logs.
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  // venueSlug opcional: permite a un OWNER cambiar de venue al loguearse
  venueSlug: z.string().min(1).max(80).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Login en dos pasos del super-admin con 2FA: la contraseña da 401
 * `{ code: 'TOTP_REQUIRED', loginTicket, expiresIn }` y este segundo paso,
 * con el ticket y el código, abre la sesión.
 */
export const LOGIN_TOTP_REQUIRED_CODE = 'TOTP_REQUIRED';
/** El ticket caducó, ya se usó o la contraseña cambió: vuelta a la contraseña. */
export const LOGIN_TICKET_EXPIRED_CODE = 'LOGIN_TICKET_EXPIRED';

const LoginTicketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Ticket de acceso no válido');

export const LoginTotpRequestSchema = z.object({
  loginTicket: LoginTicketSchema,
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras'),
});
export type LoginTotpRequest = z.infer<typeof LoginTotpRequestSchema>;

/**
 * Super-admin SIN 2FA: la 2FA es obligatoria. La contraseña da 401
 * `{ code: 'TOTP_SETUP_REQUIRED', loginTicket, expiresIn }` y con ese ticket
 * solo se puede activarla: POST /v1/auth/login/totp/setup { loginTicket } →
 * QR (TotpSetupResponse) y POST /v1/auth/login/totp/enroll { loginTicket,
 * totpCode } → la guarda y abre la sesión (como /login/totp).
 */
export const LOGIN_TOTP_SETUP_REQUIRED_CODE = 'TOTP_SETUP_REQUIRED';

export const LoginTotpSetupRequestSchema = z.object({ loginTicket: LoginTicketSchema });
export type LoginTotpSetupRequest = z.infer<typeof LoginTotpSetupRequestSchema>;

/**
 * Sesión del personal: el refresh token va en una cookie HttpOnly del API
 * (apps con la cabecera X-OxioPay-Client). Solo las apps antiguas lo reciben
 * en el cuerpo, y solo hasta AUTH_BODY_REFRESH_UNTIL.
 */
export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  refreshToken: z.string().optional(),
  refreshExpiresIn: z.number().int().positive(),
  user: z.object({
    id: UuidSchema,
    email: z.string().email(),
    role: RoleSchema,
    tenantId: UuidSchema,
    venueSlug: z.string(),
    /** Solo OWNER + flag: usuario que gestiona múltiples locales. */
    isSuperAdmin: z.boolean().optional(),
    /** Nombre visible de Personal; null si no tiene → la app pinta el puesto. */
    displayName: z.string().nullable(),
  }),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** Sin refreshToken: el de la cookie. Con él (apps antiguas), hasta AUTH_BODY_REFRESH_UNTIL. */
export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(500).optional(),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  /** Solo a las apps antiguas (las nuevas lo reciben en la cookie). */
  refreshToken: z.string().optional(),
  refreshExpiresIn: z.number().int().positive(),
  /**
   * El nombre visible de ahora (como en el login): si el dueño lo cambió en
   * Personal, o la sesión es de antes de que el login lo mandara, la app lo
   * pone sin volver a entrar. null si no tiene.
   */
  displayName: z.string().nullable(),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

/** Sin refreshToken: cierra la sesión de la cookie. */
export const LogoutRequestSchema = z.object({
  refreshToken: z.string().min(20).max(500).optional(),
});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const JwtPayloadSchema = z.object({
  sub: UuidSchema, // user.id
  email: z.string().email(),
  role: RoleSchema,
  tenantId: UuidSchema,
  venueSlug: z.string(),
  /**
   * Sesión (family del refresh token) que emitió este access token: con ella
   * el API recuerda el local elegido por el super-admin y ata la activación
   * de la 2FA a la sesión que la empezó. Falta en los tokens de antes.
   */
  sid: z.string().max(64).optional(),
  iat: z.number().optional(),
  exp: z.number().optional(),
});
export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

export const SwitchTenantRequestSchema = z.object({
  venueSlug: z.string().min(1).max(80),
});
export type SwitchTenantRequest = z.infer<typeof SwitchTenantRequestSchema>;

// ── 2FA (app de verificación) ─────────────────────────────────────────
//   GET  /v1/auth/totp          → TotpStatusResponse
//   POST /v1/auth/totp/setup    TotpSetupRequest → TotpSetupResponse (409 si ya está activada)
//   POST /v1/auth/totp/confirm  TotpConfirmRequest → { enabled: true }
//   POST /v1/auth/totp/disable  TotpCodeRequest → { enabled: false }

/** Código de 6 cifras de la app de verificación (acepta "123 456"). */
export const TotpCodeRequestSchema = z.object({
  code: z
    .string()
    .max(20)
    .transform((s) => s.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'El código son 6 cifras')),
});
export type TotpCodeRequest = z.infer<typeof TotpCodeRequestSchema>;

/** La contraseña actual: una sesión robada sola no puede activar su propia 2FA. */
const CurrentPasswordSchema = z.string().min(1).max(200);

export const TotpSetupRequestSchema = z.object({ password: CurrentPasswordSchema });
export type TotpSetupRequest = z.infer<typeof TotpSetupRequestSchema>;

export const TotpConfirmRequestSchema = TotpCodeRequestSchema.extend({ password: CurrentPasswordSchema });
export type TotpConfirmRequest = z.infer<typeof TotpConfirmRequestSchema>;

export const TotpStatusResponseSchema = z.object({
  enabled: z.boolean(),
});
export type TotpStatusResponse = z.infer<typeof TotpStatusResponseSchema>;

export const TotpSetupResponseSchema = z.object({
  /** otpauth://totp/… — lo mismo que el QR, para copiar en el móvil. */
  otpauthUrl: z.string(),
  /** Secreto base32 para teclearlo a mano si no se puede escanear. */
  secret: z.string(),
  /** data:image/png;base64,… del QR. */
  qrPngDataUrl: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;
