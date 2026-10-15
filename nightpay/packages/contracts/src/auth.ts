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

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  refreshToken: z.string(),
  refreshExpiresIn: z.number().int().positive(),
  user: z.object({
    id: UuidSchema,
    email: z.string().email(),
    role: RoleSchema,
    tenantId: UuidSchema,
    venueSlug: z.string(),
    /** Solo OWNER + flag: usuario que gestiona múltiples locales. */
    isSuperAdmin: z.boolean().optional(),
  }),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(500),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  refreshToken: z.string(),
  refreshExpiresIn: z.number().int().positive(),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

export const LogoutRequestSchema = z.object({
  refreshToken: z.string().min(20).max(500),
});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const JwtPayloadSchema = z.object({
  sub: UuidSchema, // user.id
  email: z.string().email(),
  role: RoleSchema,
  tenantId: UuidSchema,
  venueSlug: z.string(),
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
//   POST /v1/auth/totp/setup    → TotpSetupResponse (409 si ya está activada)
//   POST /v1/auth/totp/confirm  TotpCodeRequest → { enabled: true }
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
