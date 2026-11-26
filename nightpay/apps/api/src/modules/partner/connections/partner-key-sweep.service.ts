import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { PARTNER_AUDIT, partnerAuditPayload } from '../partner-audit';
import { partnerApiOn } from '../partner-flag';

/** Cada cuánto se repasan las claves (como ApprovalExpiryService). */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const DAY_MS = 86_400_000;
/** Los avisos de caducidad: a 30 y a 7 días. */
const EXPIRING_DAYS = [30, 7] as const;

/**
 * Repaso de las claves de la API de socios, cada 10 min (no en pruebas, con
 * la API apagada ni con NIGHTPAY_DISABLE_PARTNER_SWEEP=1):
 *  - los enlaces de un uso caducados sin abrir: se borra la clave sellada y
 *    queda un `claim_expired` por fila. El UPDATE … RETURNING lo hace una sola
 *    réplica aunque corran dos (la otra ya no ve la fila sellada).
 *  - las claves a 30 y a 7 días de caducar: un aviso cada vez por clave
 *    (np:pk-expiring:<id>:<días>:<keyCreatedAt> NX: una sola réplica lo da);
 *    si no se puede guardar, la reserva se suelta y el repaso siguiente lo
 *    vuelve a intentar.
 */
@Injectable()
export class PartnerKeySweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PartnerKeySweepService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.NIGHTPAY_DISABLE_PARTNER_SWEEP === '1' || !partnerApiOn()) return;
    this.timer = setInterval(() => void this.tick(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now: Date = new Date()): Promise<{ expiredClaims: number; expiring: number }> {
    if (this.running) return { expiredClaims: 0, expiring: 0 };
    this.running = true;
    try {
      return { expiredClaims: await this.expireClaims(now), expiring: await this.warnExpiring(now) };
    } catch (err) {
      this.logger.error(`Repaso de las claves de socios: ${(err as Error).message}`);
      return { expiredClaims: 0, expiring: 0 };
    } finally {
      this.running = false;
    }
  }

  private expireClaims(now: Date): Promise<number> {
    return this.prisma.asSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; tenantId: string; keyHint: string; scopes: string[]; name: string }>>`
        UPDATE partner_connections SET "keyClaimSealed" = NULL, "updatedAt" = now()
         WHERE "keyClaimSealed" IS NOT NULL AND "keyClaimExpiresAt" < ${now}
        RETURNING id, "tenantId", "keyHint", scopes, (SELECT p.name FROM partners p WHERE p.id = "partnerId") AS name`;
      for (const r of rows) {
        await this.audit.logInTx(tx, {
          action: PARTNER_AUDIT.claimExpired,
          tenantId: r.tenantId,
          targetType: 'PartnerConnection',
          targetId: r.id,
          payload: partnerAuditPayload({ ...r, partner: { name: r.name } }),
        });
      }
      return rows.length;
    });
  }

  private async warnExpiring(now: Date): Promise<number> {
    const soon = await this.prisma.asSystem((tx) =>
      tx.partnerConnection.findMany({
        where: { status: { not: 'REVOKED' }, keyExpiresAt: { gt: now, lte: new Date(now.getTime() + EXPIRING_DAYS[0] * DAY_MS) } },
        select: { id: true, tenantId: true, keyHint: true, scopes: true, keyCreatedAt: true, keyExpiresAt: true, partner: { select: { name: true } } },
      }),
    );
    let warned = 0;
    for (const c of soon) {
      const left = c.keyExpiresAt!.getTime() - now.getTime();
      const days = left <= EXPIRING_DAYS[1] * DAY_MS ? EXPIRING_DAYS[1] : EXPIRING_DAYS[0];
      const reserved = `np:pk-expiring:${c.id}:${days}:${c.keyCreatedAt.getTime()}`;
      const first = await this.redis.set(reserved, '1', 'EX', 31 * 86_400, 'NX');
      if (first !== 'OK') continue;
      try {
        // logInTx propaga el fallo (log() lo absorbería y el aviso contaría como dado).
        await this.prisma.asSystem((tx) =>
          this.audit.logInTx(tx, {
            action: PARTNER_AUDIT.keyExpiring,
            tenantId: c.tenantId,
            targetType: 'PartnerConnection',
            targetId: c.id,
            payload: partnerAuditPayload(c, { days, expiresAt: c.keyExpiresAt!.toISOString() }),
          }),
        );
      } catch (err) {
        // Sin el aviso guardado, la reserva se suelta: el repaso siguiente lo vuelve a intentar.
        await this.redis.del(reserved);
        this.logger.error(`Aviso de caducidad de la clave ${c.id} sin guardar (se reintenta): ${(err as Error).message}`);
        continue;
      }
      warned += 1;
    }
    return warned;
  }
}
