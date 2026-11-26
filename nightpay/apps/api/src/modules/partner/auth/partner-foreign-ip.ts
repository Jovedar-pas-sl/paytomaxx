import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { MONEY_SCOPES, PARTNER_SCOPES } from '@nightpay/contracts';
import { rateLimitIpKey } from '../../../common/http/client-ip';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { PARTNER_AUDIT, partnerAuditPayload, type PartnerAuditSubject } from '../partner-audit';

const DAY_MS = 86_400_000;
const DAY_S = 86_400;
/** A la tercera IP ajena en 24 h, con permisos de dinero, se pausan esos permisos. */
export const FOREIGN_IPS_TO_PAUSE = 3;

/**
 * Las IP ajenas de una conexión en las últimas 24 h, en una ventana móvil
 * (ZSET: la IP con la hora de su última llamada), en un solo paso: quita las
 * de hace más de 24 h, apunta esta y dice si es nueva y cuántas quedan.
 * KEYS[1] el ZSET; ARGV ahora (ms), ventana (ms) y la IP.
 */
export const FOREIGN_IP_WINDOW_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
local added = redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {added, redis.call('ZCARD', KEYS[1])}
`;

interface ForeignSubject extends PartnerAuditSubject {
  tenantId: string;
}

type PauseOutcome = 'paused' | 'nothing_to_pause' | 'not_active' | 'revoked' | 'missing';

/**
 * Una clave buena usada desde una IP que no está en su lista (o en las del
 * socio): cada IP nueva en 24 h (IPv6, su /64) avisa al dueño, también después
 * de la tercera (§3.3 del diseño y el contrato: cada dirección nueva avisa). Con
 * tres distintas en las últimas 24 h, los permisos de dinero de una conexión
 * activa se pausan (pausedScopes, no el estado: el CHECK pide que los pausados
 * sean de los suyos), una sola vez mientras dure la ventana.
 *
 * La pausa queda pendiente hasta que su transacción se confirma: si falla, la
 * reintenta la siguiente llamada ajena (aunque sea de una IP ya vista). Una
 * conexión en pausa (del dueño o de OxioPay) no se toca: ni su motivo ni sus
 * permisos; la pausa sigue pendiente para cuando vuelva a estar activa.
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
    const [added, distinct] = (await this.redis.eval(FOREIGN_IP_WINDOW_LUA, 1, `np:pk-foreign-ips:${conn.id}`, Date.now(), DAY_MS, ipKey)) as [
      number,
      number,
    ];
    if (Number(added) === 1) {
      await this.audit.log({
        action: PARTNER_AUDIT.foreignIp,
        tenantId: conn.tenantId,
        targetType: 'PartnerConnection',
        targetId: conn.id,
        ...(ip ? { ip } : {}),
        payload: partnerAuditPayload(conn),
      });
    }
    if (Number(distinct) < FOREIGN_IPS_TO_PAUSE) return;
    const money = new Set<string>(MONEY_SCOPES);
    if (!conn.scopes.some((s) => money.has(s))) return;
    const doneKey = `np:pk-foreign-paused:${conn.id}`;
    if ((await this.redis.get(doneKey)) !== null) return;
    const outcome = await this.pauseMoneyScopes(conn);
    // Hecha (o ya no hace falta): no se repite en 24 h. En pausa, queda pendiente.
    if (outcome !== 'not_active') await this.redis.set(doneKey, outcome, 'EX', DAY_S);
  }

  private pauseMoneyScopes(conn: ForeignSubject): Promise<PauseOutcome> {
    const money = new Set<string>(MONEY_SCOPES);
    return this.prisma.asSystem(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ status: string; scopes: string[]; pausedScopes: string[] }>>`
        SELECT status::text AS status, scopes, "pausedScopes" FROM partner_connections
         WHERE id = ${conn.id}::uuid AND "tenantId" = ${conn.tenantId}::uuid FOR UPDATE`;
      if (!row) return 'missing';
      if (row.status === 'REVOKED') return 'revoked';
      if (row.status !== 'ACTIVE') return 'not_active';
      const paused = new Set([...row.pausedScopes, ...row.scopes.filter((s) => money.has(s))]);
      if (row.scopes.filter((s) => money.has(s)).every((s) => row.pausedScopes.includes(s))) return 'nothing_to_pause';
      await tx.partnerConnection.update({
        where: { id: conn.id, tenantId: conn.tenantId },
        data: { pausedScopes: PARTNER_SCOPES.filter((s) => paused.has(s)), pausedReason: 'foreign_ip' },
      });
      await this.audit.logInTx(tx, {
        action: PARTNER_AUDIT.connectionPaused,
        tenantId: conn.tenantId,
        targetType: 'PartnerConnection',
        targetId: conn.id,
        payload: partnerAuditPayload(conn, { reason: 'foreign_ip' }),
      });
      return 'paused';
    });
  }
}
