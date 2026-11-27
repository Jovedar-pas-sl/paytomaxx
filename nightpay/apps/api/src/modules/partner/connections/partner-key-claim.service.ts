import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PARTNER_AUDIT, partnerAuditPayload } from '../partner-audit';
import { claimHash, openClaim } from './partner-key-claim';

export type ClaimPeek = { valid: true; partner: string; venue: string } | { valid: false };
export type ClaimOpen = { ok: true; key: string } | { ok: false };

const CLAIM_INCLUDE = { partner: { select: { name: true } }, venue: { select: { name: true } } } as const;

/**
 * El enlace de un uso: GET solo mira (los antivirus abren enlaces); POST, con
 * la fila bloqueada, enseña la clave una vez y la borra (`claim_opened`).
 * Vigente sin sellada (ya vista): «no vale» y `claim_reopened` (aviso al
 * dueño). Caducado: «no vale» sin registro (el repaso ya avisó).
 */
@Injectable()
export class PartnerKeyClaimService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async peek(token: string): Promise<ClaimPeek> {
    const conn = await this.prisma.asSystem((tx) =>
      tx.partnerConnection.findFirst({ where: { keyClaimHash: claimHash(token) }, include: CLAIM_INCLUDE }),
    );
    if (!conn?.keyClaimSealed || !conn.keyClaimExpiresAt || conn.keyClaimExpiresAt.getTime() <= Date.now()) return { valid: false };
    return { valid: true, partner: conn.partner.name, venue: conn.venue.name };
  }

  async open(token: string, ip: string | null): Promise<ClaimOpen> {
    const hash = claimHash(token);
    return this.prisma.asSystem(async (tx): Promise<ClaimOpen> => {
      const [locked] = await tx.$queryRaw<Array<{ id: string; tenantId: string }>>`
        SELECT id, "tenantId" FROM partner_connections WHERE "keyClaimHash" = ${hash} FOR UPDATE`;
      if (!locked) return { ok: false };
      const conn = await tx.partnerConnection.findFirst({ where: { id: locked.id, tenantId: locked.tenantId }, include: CLAIM_INCLUDE });
      if (!conn?.keyClaimExpiresAt || conn.keyClaimExpiresAt.getTime() <= Date.now()) return { ok: false };
      const audit = (action: string) =>
        this.audit.logInTx(tx, {
          action,
          tenantId: conn.tenantId,
          targetType: 'PartnerConnection',
          targetId: conn.id,
          ...(ip ? { ip } : {}),
          payload: partnerAuditPayload(conn),
        });
      if (!conn.keyClaimSealed) {
        await audit(PARTNER_AUDIT.claimReopened);
        return { ok: false };
      }
      const key = openClaim(this.config.get<string>('ENCRYPTION_KEK') ?? process.env.ENCRYPTION_KEK, conn.id, conn.keyClaimSealed);
      await tx.partnerConnection.update({ where: { id: conn.id, tenantId: conn.tenantId }, data: { keyClaimSealed: null } });
      await audit(PARTNER_AUDIT.claimOpened);
      return { ok: true, key };
    });
  }
}
