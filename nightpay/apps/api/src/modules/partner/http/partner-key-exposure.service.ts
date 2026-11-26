import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PartnerAuthLimiter } from '../auth/partner-auth-limiter';
import { hashPartnerKey } from '../auth/partner-key';
import { PARTNER_AUDIT, partnerAuditPayload } from '../partner-audit';

/**
 * Una clave que llegó en una URL (installPartnerUrlCheck): si existe (actual o
 * en su solape) queda marcada `keyExposedAt` y el dueño recibe el aviso de
 * cambiarla (una vez hasta que la cambie); si no existe, cuenta como un fallo.
 * Desde una IP bloqueada, con la clave bloqueada o con el cortacircuitos
 * levantado no se mira nada (el 400 sale antes del límite global: sin esto,
 * repetir una clave inventada consultaría la base sin tope).
 *
 * Va en segundo plano y puede cruzarse con una rotación: el UPDATE vuelve a
 * mirar que la presentada sea la clave actual o la anterior aún válida, para
 * que un aviso atrasado no marque la nueva.
 */
@Injectable()
export class PartnerKeyExposureService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PartnerAuthLimiter) private readonly limiter: PartnerAuthLimiter,
  ) {}

  async report(key: string, ip: string | null): Promise<void> {
    const keyHash = hashPartnerKey(key);
    const state = await this.limiter.state(keyHash, ip);
    if (state.ipBlocked || state.keyBlocked || (state.breaker && !state.known)) return;
    const now = new Date();
    const presented = { OR: [{ keyHash }, { prevKeyHash: keyHash, prevKeyExpiresAt: { gt: now } }] };
    const found = await this.prisma.asSystem(async (tx) => {
      const conn = await tx.partnerConnection.findFirst({
        where: presented,
        select: { id: true, tenantId: true, keyHint: true, scopes: true, partner: { select: { name: true } } },
      });
      if (!conn) return false;
      const marked = await tx.partnerConnection.updateMany({
        where: { id: conn.id, tenantId: conn.tenantId, keyExposedAt: null, ...presented },
        data: { keyExposedAt: now },
      });
      if (marked.count > 0) {
        await this.audit.logInTx(tx, {
          action: PARTNER_AUDIT.keyExposed,
          tenantId: conn.tenantId,
          targetType: 'PartnerConnection',
          targetId: conn.id,
          ...(ip ? { ip } : {}),
          payload: partnerAuditPayload(conn),
        });
      }
      return true;
    });
    if (!found) await this.limiter.recordFailure(keyHash, ip);
  }
}
