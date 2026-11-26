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
 * Desde una IP bloqueada no se mira nada.
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
    if ((await this.limiter.state(keyHash, ip)).ipBlocked) return;
    const now = new Date();
    const found = await this.prisma.asSystem(async (tx) => {
      const conn = await tx.partnerConnection.findFirst({
        where: { OR: [{ keyHash }, { prevKeyHash: keyHash, prevKeyExpiresAt: { gt: now } }] },
        select: { id: true, tenantId: true, keyHint: true, scopes: true, partner: { select: { name: true } } },
      });
      if (!conn) return false;
      const marked = await tx.partnerConnection.updateMany({
        where: { id: conn.id, tenantId: conn.tenantId, keyExposedAt: null },
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
