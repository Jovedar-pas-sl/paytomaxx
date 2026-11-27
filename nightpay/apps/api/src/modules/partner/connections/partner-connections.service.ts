import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Prisma } from '@nightpay/db';
import {
  GRANTABLE_SCOPES,
  maskEmail,
  stepUpActions,
  type CreatePartnerConnectionDto,
  type JwtPayload,
  type PartnerConnectionView,
  type PartnerConnectionsOverview,
  type PartnerKeyIssued,
  type PartnerKeyOverlap,
  type PartnerLimitsUpdateDto,
  type ResumePartnerConnectionDto,
  type RotatePartnerKeyDto,
} from '@nightpay/contracts';
import { EmailService } from '../../../common/email/email.service';
import { PrismaService, type TransactionalClient } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { TotpService } from '../../auth/totp.service';
import { LOCAL_API_ORIGIN, originOf } from '../../home-topup/home-topup-settings.service';
import { PartnerAuthLimiter } from '../auth/partner-auth-limiter';
import { generatePartnerKey, type IssuedPartnerKey } from '../auth/partner-key';
import { PARTNER_AUDIT, partnerAuditPayload } from '../partner-audit';
import { PARTNER_LOAD_AUDIT } from '../wallet/partner-load-watch';
import { partnerApiMode } from '../partner-flag';
import { claimEmail, claimUrl, newClaim, type NewClaim } from './partner-key-claim';
import {
  adminError,
  connectionIps,
  expiryProblem,
  partnerReady,
  sortScopes,
  toConnectionAdminView,
  toPartnerOption,
  type ViewRow,
} from './partner-rules';

const DAY_MS = 86_400_000;
const OVERLAP_MS: Readonly<Record<PartnerKeyOverlap, number>> = { none: 0, '24h': DAY_MS, '7d': 7 * DAY_MS };
/** La clave que sale se reconoce (401 api_key_rotated) su solape y 30 días más. */
const RETIRED_EXTRA_S = 30 * 86_400;
const FOREIGN_IPS_DAYS = 7;
const FOREIGN_IPS_MAX = 5;

const VIEW_INCLUDE = { partner: { select: { name: true } } } as const;
type Tx = TransactionalClient;

interface IssueResult {
  row: ViewRow;
  key: IssuedPartnerKey;
  claim: NewClaim | null;
  partner: { name: string; contactEmail: string };
  venueName: string;
  /** Si el correo no sale: la conexión nueva se borra; si era un cambio, vuelve la clave de antes. */
  undo: 'delete' | KeyState;
}

/** Lo que cambia al cambiar la clave: para dejarlo como estaba si el correo no sale. */
const KEY_STATE_FIELDS = [
  'keyHash',
  'keyHint',
  'keyCreatedAt',
  'keyExpiresAt',
  'prevKeyHash',
  'prevKeyExpiresAt',
  'keySuspendedAt',
  'keyExposedAt',
  'keyClaimHash',
  'keyClaimSealed',
  'keyClaimExpiresAt',
] as const;
type KeyState = Pick<Prisma.PartnerConnectionUncheckedUpdateInput, (typeof KEY_STATE_FIELDS)[number]>;

function keyState(conn: Record<(typeof KEY_STATE_FIELDS)[number], unknown>): KeyState {
  return Object.fromEntries(KEY_STATE_FIELDS.map((f) => [f, conn[f]])) as KeyState;
}

/**
 * Las conexiones del local con otras plataformas (Ajustes del dueño): conectar,
 * cambiar la clave, pausar, reanudar y anular. Todo con el local del JWT:
 * cada acceso a partner_connections (también el SQL crudo FOR UPDATE) lleva
 * `"tenantId"` (producción entra como superusuario: RLS no protege) y la de
 * otro local da el 404 de la que no existe. Cada cambio con su registro en la
 * misma transacción (sin registro no hay cambio).
 */
@Injectable()
export class PartnerConnectionsService {
  private readonly logger = new Logger(PartnerConnectionsService.name);
  private readonly limiter: PartnerAuthLimiter;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    this.limiter = new PartnerAuthLimiter(redis);
  }

  async overview(user: JwtPayload): Promise<PartnerConnectionsOverview> {
    const now = new Date();
    return this.prisma.withTenant(user.tenantId, async (tx) => {
      const rows = await tx.partnerConnection.findMany({
        where: { tenantId: user.tenantId },
        include: VIEW_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
      // Las últimas IP ajenas de cada conexión, como mucho FOREIGN_IPS_MAX: una no tapa las de otra.
      const since = new Date(now.getTime() - FOREIGN_IPS_DAYS * DAY_MS);
      const foreign: Array<{ targetId: string | null; ip: string | null; occurredAt: Date }> = [];
      for (const row of rows) {
        foreign.push(
          ...(await tx.auditEvent.findMany({
            where: { tenantId: user.tenantId, action: PARTNER_AUDIT.foreignIp, targetId: row.id, ip: { not: null }, occurredAt: { gte: since } },
            orderBy: { occurredAt: 'desc' },
            select: { targetId: true, ip: true, occurredAt: true },
            take: FOREIGN_IPS_MAX,
          })),
        );
      }
      const partners = user.role === 'OWNER' ? await tx.partner.findMany({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } }) : [];
      return {
        emailEnabled: this.email.isEnabled(),
        partners: partners.filter(partnerReady).map((p) => toPartnerOption(p, GRANTABLE_SCOPES)),
        connections: rows.map((row) => {
          const ips = foreign
            .filter((f) => f.targetId === row.id && f.ip)
            .slice(0, FOREIGN_IPS_MAX)
            .map((f) => ({ ip: f.ip!, at: f.occurredAt.toISOString() }));
          return toConnectionAdminView(row, ips, now);
        }),
      };
    });
  }

  async create(user: JwtPayload, dto: CreatePartnerConnectionDto): Promise<PartnerKeyIssued> {
    await this.totp.assertForUser(user.sub, dto.totpCode, stepUpActions.partner('create', dto.partnerId));
    const mode = this.mode();
    const now = new Date();
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const issued = await this.prisma.withTenant(user.tenantId, async (tx): Promise<IssueResult> => {
      const partner = await tx.partner.findUnique({ where: { id: dto.partnerId } });
      if (!partner || !partnerReady(partner)) throw adminError('PARTNER_NOT_READY');
      const allowed = new Set(partner.allowedScopes.filter((s) => (GRANTABLE_SCOPES as readonly string[]).includes(s)));
      if (dto.scopes.some((s) => !allowed.has(s))) throw adminError('PARTNER_SCOPE_NOT_ALLOWED');
      const scopes = sortScopes(dto.scopes);
      const ipAllowlist = connectionIps(dto.ipAllowlist, partner.egressIps, scopes, mode);
      if (expiryProblem(expiresAt, scopes, now)) throw adminError('PARTNER_EXPIRY_INVALID');
      const venue = await tx.venue.findUnique({
        where: { id: user.tenantId },
        select: { name: true, businessId: true, business: { select: { taxId: true } } },
      });
      if (!venue?.businessId || !venue.business?.taxId) throw adminError('PARTNER_VENUE_NO_BUSINESS');
      this.assertDelivery(dto.delivery);
      const existing = await tx.partnerConnection.findFirst({
        where: { tenantId: user.tenantId, partnerId: partner.id, status: { not: 'REVOKED' } },
        select: { id: true },
      });
      if (existing) throw adminError('PARTNER_ALREADY_CONNECTED');
      // Lo que pausó o anuló OxioPay no se esquiva anulando y conectando otra vez.
      const byOxioPay = await tx.partnerConnection.findFirst({
        where: { tenantId: user.tenantId, partnerId: partner.id, pausedReason: 'oxiopay', status: { in: ['PAUSED', 'REVOKED'] } },
        select: { id: true },
      });
      if (byOxioPay) throw adminError('PARTNER_PAUSED_BY_OXIOPAY');

      const id = randomUUID();
      const key = generatePartnerKey(mode);
      const claim = dto.delivery === 'email' ? newClaim(this.kek(), id, key.key, now) : null;
      const row = await tx.partnerConnection
        .create({
          data: {
            id,
            tenantId: user.tenantId,
            partnerId: partner.id,
            businessId: venue.businessId,
            collectionModel: partner.collectionModel,
            channel: partner.channel,
            scopes,
            keyMode: mode,
            keyHash: key.hash,
            keyHint: key.hint,
            keyCreatedAt: now,
            keyExpiresAt: expiresAt,
            ipAllowlist,
            createdById: user.sub,
            ...(claim ? { keyClaimHash: claim.hash, keyClaimSealed: claim.sealed, keyClaimExpiresAt: claim.expiresAt } : {}),
          },
          include: VIEW_INCLUDE,
        })
        .catch((err: unknown) => {
          // El doble clic: el índice único parcial (una conexión viva por socio y local).
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw adminError('PARTNER_ALREADY_CONNECTED');
          throw err;
        });
      await this.audit.logInTx(tx, this.auditRow(user, PARTNER_AUDIT.keyCreated, row));
      return { row, key, claim, partner, venueName: venue.name, undo: 'delete' };
    });
    return this.deliver(user, issued, now);
  }

  async rotate(user: JwtPayload, id: string, dto: RotatePartnerKeyDto): Promise<PartnerKeyIssued> {
    await this.totp.assertForUser(user.sub, dto.totpCode, stepUpActions.partner('rotate', id));
    const now = new Date();
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const issued = await this.prisma.withTenant(user.tenantId, async (tx): Promise<IssueResult> => {
      const conn = await this.lockOwn(tx, user.tenantId, id);
      if (conn.status === 'REVOKED') throw adminError('PARTNER_CONNECTION_REVOKED');
      const partner = await tx.partner.findUnique({ where: { id: conn.partnerId } });
      if (!partner || !partnerReady(partner)) throw adminError('PARTNER_NOT_READY');
      if (expiryProblem(expiresAt, conn.scopes, now)) throw adminError('PARTNER_EXPIRY_INVALID');
      this.assertDelivery(dto.delivery);
      const venue = await tx.venue.findUnique({ where: { id: user.tenantId }, select: { name: true } });

      const before = keyState(conn);
      const key = generatePartnerKey(conn.keyMode === 'live' ? 'live' : 'test');
      const claim = dto.delivery === 'email' ? newClaim(this.kek(), conn.id, key.key, now) : null;
      // El solape nunca alarga la vida de la clave que sale.
      const overlapEnd = Math.min(now.getTime() + OVERLAP_MS[dto.overlap], conn.keyExpiresAt?.getTime() ?? Infinity);
      const keepOld = overlapEnd > now.getTime();
      const retire: Array<[string, number]> = [[conn.keyHash, (keepOld ? (overlapEnd - now.getTime()) / 1000 : 0) + RETIRED_EXTRA_S]];
      if (conn.prevKeyHash) retire.push([conn.prevKeyHash, RETIRED_EXTRA_S]);
      const row = await tx.partnerConnection.update({
        where: { id: conn.id, tenantId: user.tenantId },
        data: {
          keyHash: key.hash,
          keyHint: key.hint,
          keyCreatedAt: now,
          keyExpiresAt: expiresAt,
          prevKeyHash: keepOld ? conn.keyHash : null,
          prevKeyExpiresAt: keepOld ? new Date(overlapEnd) : null,
          keySuspendedAt: null,
          keyExposedAt: null,
          keyClaimHash: claim?.hash ?? null,
          keyClaimSealed: claim?.sealed ?? null,
          keyClaimExpiresAt: claim?.expiresAt ?? null,
        },
        include: VIEW_INCLUDE,
      });
      await this.audit.logInTx(tx, this.auditRow(user, PARTNER_AUDIT.keyRotated, row, { overlap: dto.overlap }));
      // Antes de confirmar: sin Redis no hay rotación (la vieja diría invalid_api_key y contaría como fallo).
      for (const [hash, ttl] of retire) await this.limiter.retire(hash, ttl);
      return { row, key, claim, partner, venueName: venue?.name ?? '', undo: before };
    });
    return this.deliver(user, issued, now);
  }

  async pause(user: JwtPayload, id: string): Promise<PartnerConnectionView> {
    return this.change(user, id, async (tx, conn) => {
      if (conn.status === 'PAUSED') return conn;
      const row = await tx.partnerConnection.update({
        where: { id: conn.id, tenantId: user.tenantId },
        data: { status: 'PAUSED', pausedReason: user.role === 'OWNER' ? 'owner' : 'manager' },
        include: VIEW_INCLUDE,
      });
      await this.audit.logInTx(tx, this.auditRow(user, PARTNER_AUDIT.connectionPaused, row, { reason: row.pausedReason }));
      return row;
    });
  }

  async revoke(user: JwtPayload, id: string): Promise<PartnerConnectionView> {
    return this.change(user, id, async (tx, conn) => {
      if (conn.status === 'PAUSED' && conn.pausedReason === 'oxiopay') throw adminError('PARTNER_PAUSED_BY_OXIOPAY');
      const row = await tx.partnerConnection.update({
        where: { id: conn.id, tenantId: user.tenantId },
        data: { status: 'REVOKED', keyClaimHash: null, keyClaimSealed: null, keyClaimExpiresAt: null },
        include: VIEW_INCLUDE,
      });
      await this.audit.logInTx(tx, this.auditRow(user, PARTNER_AUDIT.keyRevoked, row));
      return row;
    }, true);
  }

  async resume(user: JwtPayload, id: string, dto: ResumePartnerConnectionDto): Promise<PartnerConnectionView> {
    await this.totp.assertForUser(user.sub, dto.totpCode, stepUpActions.partner('resume', id));
    return this.change(user, id, async (tx, conn) => {
      if (conn.status === 'PAUSED' && conn.pausedReason === 'oxiopay') throw adminError('PARTNER_PAUSED_BY_OXIOPAY');
      const row = await tx.partnerConnection.update({
        where: { id: conn.id, tenantId: user.tenantId },
        data: { status: 'ACTIVE', pausedScopes: [], pausedReason: null, keySuspendedAt: null, keyResumedAt: new Date() },
        include: VIEW_INCLUDE,
      });
      await this.audit.logInTx(tx, this.auditRow(user, PARTNER_AUDIT.connectionResumed, row));
      return row;
    });
  }

  /**
   * Los topes de carga (OWNER). 2FA solo si sube alguno, atada a los tres
   * valores; con la fila bloqueada, si ahora sube y antes no (sin 2FA), 409.
   */
  async updateLimits(user: JwtPayload, id: string, dto: PartnerLimitsUpdateDto): Promise<PartnerConnectionView> {
    const after = { perOperationCents: dto.perOperationCents, walletDayCents: dto.walletDayCents, nightCents: dto.nightCents };
    const raises = (c: { loadPerOpMaxCents: number; loadWalletDayMaxCents: number; loadNightMaxCents: number }) =>
      after.perOperationCents > c.loadPerOpMaxCents || after.walletDayCents > c.loadWalletDayMaxCents || after.nightCents > c.loadNightMaxCents;
    const current = await this.prisma.withTenant(user.tenantId, (tx) =>
      tx.partnerConnection.findFirst({
        where: { id, tenantId: user.tenantId },
        select: { loadPerOpMaxCents: true, loadWalletDayMaxCents: true, loadNightMaxCents: true },
      }),
    );
    if (!current) throw adminError('PARTNER_CONNECTION_NOT_FOUND');
    const stepUp = raises(current);
    if (stepUp) {
      await this.totp.assertForUser(
        user.sub,
        dto.totpCode,
        stepUpActions.partner('limits', id, `${after.perOperationCents}-${after.walletDayCents}-${after.nightCents}`),
      );
    }
    return this.change(user, id, async (tx, conn) => {
      if (!stepUp && raises(conn)) throw adminError('PARTNER_LIMITS_CHANGED');
      const before = { perOperationCents: conn.loadPerOpMaxCents, walletDayCents: conn.loadWalletDayMaxCents, nightCents: conn.loadNightMaxCents };
      const row = await tx.partnerConnection.update({
        where: { id: conn.id, tenantId: user.tenantId },
        data: { loadPerOpMaxCents: after.perOperationCents, loadWalletDayMaxCents: after.walletDayCents, loadNightMaxCents: after.nightCents },
        include: VIEW_INCLUDE,
      });
      await this.audit.logInTx(tx, this.auditRow(user, PARTNER_LOAD_AUDIT.capsChanged, row, { before, after }));
      return row;
    });
  }

  /** Un cambio sobre una conexión del local, bloqueada; anulada no se toca (revocar dos veces no hace nada). */
  private async change(
    user: JwtPayload,
    id: string,
    fn: (tx: Tx, conn: ViewRow & { partnerId: string }) => Promise<ViewRow>,
    revoking = false,
  ): Promise<PartnerConnectionView> {
    const now = new Date();
    const row = await this.prisma.withTenant(user.tenantId, async (tx) => {
      const conn = await this.lockOwn(tx, user.tenantId, id);
      if (conn.status === 'REVOKED') {
        if (revoking) return conn;
        throw adminError('PARTNER_CONNECTION_REVOKED');
      }
      return fn(tx, conn);
    });
    return toConnectionAdminView(row, [], now);
  }

  /** La conexión del local, bloqueada para el cambio; la de otro local, como si no existiera. */
  private async lockOwn(tx: Tx, tenantId: string, id: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM partner_connections WHERE id = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw adminError('PARTNER_CONNECTION_NOT_FOUND');
    const conn = await tx.partnerConnection.findFirst({ where: { id, tenantId }, include: VIEW_INCLUDE });
    if (!conn) throw adminError('PARTNER_CONNECTION_NOT_FOUND');
    return conn;
  }

  /**
   * Tras confirmar: el enlace por correo. Si no sale, nadie tiene la clave nueva:
   * se deshace en esta misma llamada (la conexión nueva se borra; en un cambio,
   * vuelve la clave de antes) y la respuesta dice que no salió.
   */
  private async deliver(user: JwtPayload, issued: IssueResult, now: Date): Promise<PartnerKeyIssued> {
    const { key, claim, partner, venueName } = issued;
    let { row } = issued;
    let delivered = false;
    if (claim) {
      const origin = originOf(this.config.get<string>('NEXT_PUBLIC_API_URL')) ?? LOCAL_API_ORIGIN;
      const mail = claimEmail(partner.name, venueName, claimUrl(origin, claim.token));
      const sent = await this.email.send({ to: partner.contactEmail, ...mail }).catch(() => ({ delivered: false }));
      delivered = sent.delivered;
      if (!delivered) {
        this.logger.warn(`El enlace de la clave de la conexión ${row.id} no salió por correo: se deshace`);
        row = await this.undoIssue(user, issued);
      }
    }
    return {
      connection: toConnectionAdminView(row, [], now),
      ...(claim ? {} : { key: key.key }),
      claim: {
        sentTo: claim ? maskEmail(partner.contactEmail) : null,
        expiresAt: claim?.expiresAt.toISOString() ?? null,
        delivered,
      },
    };
  }

  /** Deshace la conexión o el cambio de clave, si nadie la ha tocado después (sigue con la clave nueva). */
  private async undoIssue(user: JwtPayload, issued: IssueResult): Promise<ViewRow> {
    const { row, key, undo } = issued;
    return this.prisma.withTenant(user.tenantId, async (tx) => {
      const conn = await this.lockOwn(tx, user.tenantId, row.id).catch(() => null);
      if (!conn || conn.keyHash !== key.hash) return conn ?? row;
      if (undo === 'delete') {
        await tx.partnerConnection.delete({ where: { id: conn.id, tenantId: user.tenantId } });
        await this.audit.logInTx(tx, this.auditRow(user, PARTNER_AUDIT.keyIssueUndone, conn, { undone: 'created', reason: 'email_failed' }));
        return { ...conn, status: 'REVOKED' };
      }
      const restored = await tx.partnerConnection.update({ where: { id: conn.id, tenantId: user.tenantId }, data: undo, include: VIEW_INCLUDE });
      await this.audit.logInTx(tx, this.auditRow(user, PARTNER_AUDIT.keyIssueUndone, restored, { undone: 'rotated', reason: 'email_failed' }));
      return restored;
    });
  }

  private assertDelivery(delivery: 'copy' | 'email'): void {
    if (delivery === 'email' && !this.email.isEnabled()) throw adminError('PARTNER_EMAIL_OFF');
  }

  private mode(): 'live' | 'test' {
    const mode = partnerApiMode();
    if (!mode) throw new Error('PARTNER_API_MODE sin definir con la API de socios encendida');
    return mode;
  }

  private kek(): string | undefined {
    return this.config.get<string>('ENCRYPTION_KEK') ?? process.env.ENCRYPTION_KEK;
  }

  private auditRow(user: JwtPayload, action: string, row: ViewRow & { id: string }, extra: Record<string, unknown> = {}) {
    return {
      action,
      tenantId: user.tenantId,
      actorId: user.sub,
      actorEmail: user.email ?? null,
      targetType: 'PartnerConnection',
      targetId: row.id,
      payload: partnerAuditPayload(row, extra),
    };
  }
}
