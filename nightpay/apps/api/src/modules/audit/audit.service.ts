import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { RequestContext } from '../../common/context/request-context';

/**
 * AuditService — escribe a `audit_events` (append-only: un trigger de la BD
 * rechaza UPDATE/DELETE/TRUNCATE, migración 20261015070000_audit_append_only).
 *
 * Convencion `action`: dot-notation
 *   auth.login.ok | auth.login.failed | auth.lockout
 *   refund.created | refund.failed | refund.totp_invalid
 *   credential.set | credential.rotated
 *   user.created | user.password_reset | user.role_changed
 *   payment.created | payment.expired | payment.orphan_resolved
 */
export interface AuditInput {
  action: string;
  tenantId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown> | null;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly prisma: PrismaService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.cls = cls;
  }

  async log(input: AuditInput): Promise<void> {
    const traceId = this.cls.get('ctx')?.traceId;
    try {
      // Audit no tiene tenantId-scoped middleware (no esta en TENANT_SCOPED_MODELS).
      // Insertamos directo.
      await this.prisma.auditEvent.create({
        data: {
          action: input.action,
          tenantId: input.tenantId ?? null,
          actorId: input.actorId ?? null,
          actorEmail: input.actorEmail ?? null,
          targetType: input.targetType,
          targetId: input.targetId,
          // Textos largos recortados: la tabla no se puede limpiar (append-only).
          payload: (input.payload ? truncatePayload(input.payload) : null) as never,
          ip: input.ip,
          userAgent: input.userAgent,
          traceId,
        },
      });
    } catch (err) {
      // Audit no debe bloquear la operacion principal — solo loguear.
      this.logger.error(
        `Failed to write audit event ${input.action}: ${(err as Error).message}`,
      );
    }
  }
}

/** Máximo de caracteres de cada texto del payload (mensajes de error, respuestas…). */
export const MAX_AUDIT_STRING = 512;
const MAX_AUDIT_DEPTH = 6;
const TRUNCATED_MARK = '…[cortado]';

function truncateValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_AUDIT_STRING ? `${value.slice(0, MAX_AUDIT_STRING)}${TRUNCATED_MARK}` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_AUDIT_DEPTH) return '[demasiado anidado]';
  if (Array.isArray(value)) return value.map((item) => truncateValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateValue(v, depth + 1)]));
}

/**
 * Copia del payload con los textos largos recortados (audit_events es
 * append-only: lo que entra se queda; y un error con stack de 50 KB no aporta).
 */
export function truncatePayload(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return truncateValue(payload, 0) as Record<string, unknown>;
}
