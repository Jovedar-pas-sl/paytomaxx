import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { RequestContext } from '../../common/context/request-context';

/**
 * AuditService — escribe a `audit_events` (append-only).
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
          payload: (input.payload ?? null) as never,
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
