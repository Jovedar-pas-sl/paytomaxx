import { z } from 'zod';
import { UuidSchema } from './common';

export const RoleSchema = z.enum(['OWNER', 'MANAGER', 'WAITER']);
export type Role = z.infer<typeof RoleSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
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
