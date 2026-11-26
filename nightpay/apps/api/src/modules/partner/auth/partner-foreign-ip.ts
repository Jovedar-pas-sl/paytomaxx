import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { MONEY_SCOPES, PARTNER_SCOPES } from '@nightpay/contracts';
import { rateLimitIpKey } from '../../../common/http/client-ip';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { PARTNER_AUDIT, partnerAuditPayload, type PartnerAuditSubject } from '../partner-audit';

const DAY_S = 86_400;
/** A la tercera IP ajena en 24 h, con permisos de dinero, se pausan esos permisos. */
export const FOREIGN_IPS_TO_PAUSE = 3;

interface ForeignSubject extends PartnerAuditSubject {
  tenantId: string;
}

/**
 * Una clave buena usada desde una IP que no está en su lista (o en las del
 * socio): cada IP nueva (IPv6, su /64) avisa al dueño una vez en 24 h; a la
 * tercera, los permisos de dinero de la conexión se pausan (pausedScopes, no
 * el estado: el CHECK pide que los pausados sean de los suyos). Después, ni
 * registro ni aviso hasta que caduque el contador.
 */
@Injectable()
export class PartnerForeignIpService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async record(conn: ForeignSubject, ip: string | null): Promise<void> {
    const ipKey = ip ? rateLimitIpKey(ip) : 'desconocida';
    const fresh = await this.redis.set(`np:pk-foreign:${conn.id}:${ipKey}`, '1', 'EX', DAY_S, 'NX');
    if (fresh !== 'OK') return;
    const countKey = `np:pk-foreign-n:${conn.id}`;
    const n = await this.redis.incr(countKey);
    if (n === 1) await this.redis.expire(countKey, DAY_S);
    if (n > FOREIGN_IPS_TO_PAUSE) return;
    await this.audit.log({
      action: PARTNER_AUDIT.foreignIp,
      tenantId: conn.tenantId,
      targetType: 'PartnerConnection',
      targetId: conn.id,
      ...(ip ? { ip } : {}),
      payload: partnerAuditPayload(conn),
    });
    if (n === FOREIGN_IPS_TO_PAUSE) await this.pauseMoneyScopes(conn);
  }

  private async pauseMoneyScopes(conn: ForeignSubject): Promise<void> {
    const money = new Set<string>(MONEY_SCOPES);
    if (!conn.scopes.some((s) => money.has(s))) return;
    await this.prisma.asSystem(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ scopes: string[]; pausedScopes: string[] }>>`
        SELECT scopes, "pausedScopes" FROM partner_connections
         WHERE id = ${conn.id}::uuid AND "tenantId" = ${conn.tenantId}::uuid FOR UPDATE`;
      if (!row) return;
      const paused = new Set([...row.pausedScopes, ...row.scopes.filter((s) => money.has(s))]);
      await tx.partnerConnection.update({
        where: { id: conn.id },
        data: { pausedScopes: PARTNER_SCOPES.filter((s) => paused.has(s)), pausedReason: 'foreign_ip' },
      });
      await this.audit.logInTx(tx, {
        action: PARTNER_AUDIT.connectionPaused,
        tenantId: conn.tenantId,
        targetType: 'PartnerConnection',
        targetId: conn.id,
        payload: partnerAuditPayload(conn, { reason: 'foreign_ip' }),
      });
    });
  }
}
