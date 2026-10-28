import { Inject, Injectable } from '@nestjs/common';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService, type AuditInput } from '../audit/audit.service';
import { maskSensitive } from './masking';
import type { SuperAdminActor } from './superadmin.guard';

export interface SuperAdminAuditInput {
  /** Sin el prefijo: "venue.paused" se guarda como "superadmin.venue.paused". */
  action: string;
  /** Local afectado (null = global: un negocio, un super-admin…). */
  tenantId?: string | null;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  extra?: Record<string, unknown>;
}

/** Prefijo de todo lo que hace la consola en audit_events. */
export const SUPERADMIN_AUDIT_PREFIX = 'superadmin.';

/**
 * Registro de cada escritura de la consola: quién (super-admin, IP y
 * navegador), qué, sobre qué, antes/después y el motivo. Lo secreto va tapado
 * (maskSensitive). audit_events es append-only (trigger).
 */
@Injectable()
export class SuperAdminAuditService {
  private readonly audit: AuditService;

  constructor(@Inject(AuditService) audit: AuditService) {
    this.audit = audit;
  }

  async write(actor: SuperAdminActor, input: SuperAdminAuditInput): Promise<void> {
    await this.audit.log(this.rowFor(actor, input));
  }

  /**
   * En la misma transacción que el cambio (pagos, cuenta de OxioPay): si el
   * registro no se puede escribir, el cambio tampoco se hace.
   */
  async writeInTx(tx: Pick<TransactionalClient, 'auditEvent'>, actor: SuperAdminActor, input: SuperAdminAuditInput): Promise<void> {
    await this.audit.logInTx(tx, this.rowFor(actor, input));
  }

  private rowFor(actor: SuperAdminActor, input: SuperAdminAuditInput): AuditInput {
    return {
      action: `${SUPERADMIN_AUDIT_PREFIX}${input.action}`,
      tenantId: input.tenantId ?? null,
      actorId: actor.id,
      actorEmail: actor.email,
      targetType: input.targetType,
      targetId: input.targetId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      payload: maskSensitive({
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.extra ?? {}),
      }) as Record<string, unknown>,
    };
  }
}
