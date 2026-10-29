import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  BANK_HOLD_RELEASED_EVENT,
  BANK_RELEASE_CODES,
  formatChargeRef,
  type BankHoldList,
  type BankHoldSale,
  type BankReleaseBlock,
  type BankReleaseResult,
  type Role,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { RequestContext } from '../../common/context/request-context';
import { AuditService } from '../audit/audit.service';
import { TotpService } from '../auth/totp.service';
import { earningBankHeldSql, earningNetSql, paymentBankHeldSql } from './bank-hold-sql';

/** Las ventas retenidas que se enseñan de una persona (las más antiguas primero). */
const LIST_LIMIT = 100;

type Viewer = { userId: string; role: Role };
type Actor = Viewer & { tenantId: string };

/** De la petición, para el registro de «Liberar»: la IP real y el navegador. */
export interface ReleaseMeta {
  ip?: string;
  userAgent?: string;
}

interface HeldSaleRow {
  paymentId: string;
  ref: number | null;
  chargedCents: number;
  shareCents: number;
  at: Date;
  createdByUserId: string | null;
  confirmedByUserId: string | null;
  confirmedByName: string | null;
  device: boolean;
  terminalLabel: string | null;
  authCode: string | null;
  posOperationNumber: string | null;
}

interface PaymentHoldState {
  id: string;
  createdByUserId: string | null;
  confirmedByUserId: string | null;
  unproven: boolean;
  released: boolean;
  matched: boolean;
  chargedCents: number;
}

/**
 * Quién puede liberar la comisión retenida de una venta por datáfono: solo el
 * dueño, y nunca quien la apuntó (creó el cobro) ni quien la confirmó. Pura.
 */
export function releaseBlockOf(
  viewer: Viewer,
  sale: { createdByUserId: string | null; confirmedByUserId: string | null },
): BankReleaseBlock {
  if (viewer.role !== 'OWNER') return 'not_owner';
  if (viewer.userId === sale.createdByUserId || viewer.userId === sale.confirmedByUserId) return 'own_sale';
  return null;
}

/**
 * Ventas por datáfono sin prueba del banco (H-1): la lista con la parte
 * retenida de una persona y «Liberar». Liberar = el dueño, con su 2FA, apunta
 * en el cobro el evento `pos.bank_released` (y el registro): a partir de ahí
 * la comisión entra en el próximo pago como cualquier otra. Las tablas con
 * FORCE RLS (operator_earnings) van dentro de withTenant, con el local
 * explícito en el SQL.
 */
@Injectable()
export class BankHoldsService {
  private readonly logger = new Logger(BankHoldsService.name);
  private readonly prisma: PrismaService;
  private readonly totp: TotpService;
  private readonly audit: AuditService;
  private readonly cls: ClsService<{ ctx: RequestContext }> | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(TotpService) totp: TotpService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ClsService) cls?: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.totp = totp;
    this.audit = audit;
    this.cls = cls ?? null;
  }

  /** Lo retenido de esta persona del local: el total, cuántas ventas y cada una (quien mira, ¿puede liberarla?). */
  async listForOperator(tenantId: string, operatorId: string, viewer: Viewer): Promise<BankHoldList> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<HeldSaleRow[]>`
      SELECT p.id AS "paymentId", p.ref,
             (p."amountCents" + p."serviceFeeCents" + p."tipCents")::int AS "chargedCents",
             SUM(${earningNetSql('e')})::int AS "shareCents",
             COALESCE(p."authorizedAt", p."createdAt") AS at,
             p."createdByUserId", p."authCode", p."posOperationNumber",
             c."confirmedByUserId", cu."displayName" AS "confirmedByName",
             EXISTS (SELECT 1 FROM payment_events d
                      WHERE d."paymentId" = p.id AND d."eventType" = 'pos.device_unproven') AS device,
             t.label AS "terminalLabel"
        FROM operator_earnings e
        JOIN payments p ON p.id = e."paymentId"
        LEFT JOIN LATERAL (
          SELECT ev.payload ->> 'confirmedByUserId' AS "confirmedByUserId"
            FROM payment_events ev
           WHERE ev."paymentId" = p.id AND ev."eventType" = 'pos.confirmed'
           ORDER BY ev.id DESC
           LIMIT 1
        ) c ON true
        LEFT JOIN users cu ON cu.id::text = c."confirmedByUserId"
        LEFT JOIN terminals t ON t.id = COALESCE(p."posTerminalId", p."terminalId")
       WHERE e."tenantId" = ${tenantId}::uuid
         AND e."operatorId" = ${operatorId}::uuid
         AND e."payoutId" IS NULL
         AND ${earningBankHeldSql('e')}
       GROUP BY p.id, c."confirmedByUserId", cu."displayName", t.label
      HAVING SUM(${earningNetSql('e')}) > 0
       ORDER BY COALESCE(p."authorizedAt", p."createdAt") ASC, p.id
       LIMIT ${LIST_LIMIT + 1}
    `);
    const totals = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<Array<{ cents: bigint | null; sales: bigint | null }>>`
      SELECT COALESCE(SUM(${earningNetSql('e')}), 0)::bigint AS cents,
             COUNT(DISTINCT e."paymentId") FILTER (WHERE ${earningNetSql('e')} > 0)::bigint AS sales
        FROM operator_earnings e
       WHERE e."tenantId" = ${tenantId}::uuid
         AND e."operatorId" = ${operatorId}::uuid
         AND e."payoutId" IS NULL
         AND ${earningBankHeldSql('e')}
    `);
    const sales = rows.slice(0, LIST_LIMIT).map((r): BankHoldSale => ({
      paymentId: r.paymentId,
      ref: formatChargeRef(r.ref),
      chargedCents: r.chargedCents,
      shareCents: r.shareCents,
      at: r.at.toISOString(),
      via: r.device ? 'datafono' : 'camarero',
      confirmedBy: r.device ? (r.terminalLabel ?? null) : (r.confirmedByName ?? null),
      receiptRef: r.device ? r.posOperationNumber : r.authCode,
      releaseBlock: releaseBlockOf(viewer, r),
    }));
    return { totalCents: Number(totals[0]?.cents ?? 0), count: Number(totals[0]?.sales ?? 0), sales };
  }

  /**
   * El dueño libera la comisión retenida de una venta por datáfono: con su
   * 2FA (obligatoria), nunca la suya (la apuntó o la confirmó él) y con
   * registro. Ya liberada o ya cuadrada con el banco: no se hace nada (ni se
   * pide el código). Dos a la vez: una la apunta y la otra ve que ya está.
   * El registro va en la misma transacción que el evento: o quedan los dos o
   * ninguno (sin registro, no se libera).
   */
  async release(
    actor: Actor,
    paymentId: string,
    dto: { totpCode?: string; note?: string },
    meta: ReleaseMeta = {},
  ): Promise<BankReleaseResult> {
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException({ message: 'Solo el dueño puede liberar una venta por datáfono.', code: BANK_RELEASE_CODES.OWNER_ONLY });
    }
    const state = await this.holdState(actor.tenantId, paymentId);
    if (!state) throw new NotFoundException('Cobro no encontrado');
    if (!state.unproven) {
      throw new ConflictException({
        message: 'Este cobro no es una venta por datáfono pendiente de cuadrar: su comisión ya se paga como las demás.',
        code: BANK_RELEASE_CODES.NOT_HELD,
      });
    }
    if (state.released) return { paymentId, status: 'ALREADY_RELEASED' };
    if (state.matched) return { paymentId, status: 'MATCHED' };
    if (releaseBlockOf(actor, state) === 'own_sale') {
      throw new ForbiddenException({
        message: 'Esta venta la apuntaste o la confirmaste tú: la tiene que liberar otro dueño, o cuadrarla con el fichero del banco.',
        code: BANK_RELEASE_CODES.OWN_SALE,
      });
    }
    // Liberar es dar por bueno dinero sin prueba del banco: 2FA siempre.
    await this.totp.assertForUser(actor.userId, dto.totpCode);
    const note = dto.note?.trim() || null;
    const released = await this.prisma.asSystem(async (tx) => {
      // De una en una por cobro: la segunda ve la primera.
      await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`bank-release:${paymentId}`}))`;
      const already = await tx.paymentEvent.findFirst({
        where: { paymentId, eventType: BANK_HOLD_RELEASED_EVENT },
        select: { id: true },
      });
      if (already) return false;
      await tx.paymentEvent.create({
        data: {
          paymentId,
          tenantId: actor.tenantId,
          eventType: BANK_HOLD_RELEASED_EVENT,
          payload: { releasedByUserId: actor.userId, note },
          traceId: this.cls?.get('ctx')?.traceId ?? randomUUID(),
        },
      });
      await this.audit.logInTx(tx, {
        action: 'pos.bank_hold_released',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        targetType: 'Payment',
        targetId: paymentId,
        payload: { chargedCents: state.chargedCents, note },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return true;
    });
    if (!released) return { paymentId, status: 'ALREADY_RELEASED' };
    this.logger.log(`Venta por datáfono ${paymentId} liberada a mano por ${actor.userId} (sin cuadrar con el banco)`);
    return { paymentId, status: 'RELEASED' };
  }

  /** El cobro del local y en qué está su retención. */
  private async holdState(tenantId: string, paymentId: string): Promise<PaymentHoldState | null> {
    const rows = await this.prisma.asSystem((tx) => tx.$queryRaw<PaymentHoldState[]>`
      SELECT p.id, p."createdByUserId",
             (p."amountCents" + p."serviceFeeCents" + p."tipCents")::int AS "chargedCents",
             (SELECT ev.payload ->> 'confirmedByUserId' FROM payment_events ev
               WHERE ev."paymentId" = p.id AND ev."eventType" = 'pos.confirmed'
               ORDER BY ev.id DESC LIMIT 1) AS "confirmedByUserId",
             EXISTS (SELECT 1 FROM payment_events u
                      WHERE u."paymentId" = p.id AND u."eventType" IN ('pos.confirmed', 'pos.device_unproven')) AS unproven,
             EXISTS (SELECT 1 FROM payment_events rl
                      WHERE rl."paymentId" = p.id AND rl."eventType" = ${BANK_HOLD_RELEASED_EVENT}) AS released,
             NOT ${paymentBankHeldSql('p')} AND NOT EXISTS (SELECT 1 FROM payment_events rl2
                      WHERE rl2."paymentId" = p.id AND rl2."eventType" = ${BANK_HOLD_RELEASED_EVENT}) AS matched
        FROM payments p
       WHERE p.id = ${paymentId}::uuid
         AND p."tenantId" = ${tenantId}::uuid
    `);
    return rows[0] ?? null;
  }
}
