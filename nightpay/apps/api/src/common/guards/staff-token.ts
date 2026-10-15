import type { JwtService } from '@nestjs/jwt';
import { JwtPayloadSchema, type JwtPayload } from '@nightpay/contracts';

export type StaffTokenResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: 'invalid' | 'malformed' };

/**
 * Verifica el JWT de sesión del personal (Bearer). Lo usan AuthGuard y el
 * gateway de tiempo real. Los JWT de un solo uso que se firman con la misma
 * clave (invitación, alta de la chica) llevan `purpose` y no valen como sesión.
 */
export async function verifyStaffToken(jwt: JwtService, token: string): Promise<StaffTokenResult> {
  let raw: unknown;
  try {
    raw = await jwt.verifyAsync(token);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof raw === 'object' && raw !== null && 'purpose' in raw) return { ok: false, reason: 'malformed' };
  const parsed = JwtPayloadSchema.safeParse(raw);
  return parsed.success ? { ok: true, payload: parsed.data } : { ok: false, reason: 'malformed' };
}

/** `Authorization: Bearer <token>` → token, o null. */
export function bearerToken(header: unknown): string | null {
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() || null : null;
}
