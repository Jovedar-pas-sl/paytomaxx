import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  paymentMethodsOf,
  type CashTopUpDto,
  type CashTopUpResult,
  type DeviceCardTopUpDto,
  type ReceptionOptions,
  type TopUpWalletDto,
} from '@nightpay/contracts';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../common/context/request-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { venuePauseScope, VENUE_PAUSE_SELECT } from '../venues/venue-pause';
import { CashTopUpService } from '../wallets/wallet-cash-topup.service';
import { codeHintOf } from '../wallets/wallet-charges.service';
import { topUpTarget } from '../wallets/wallet-topup-target';
import { RECEPTION_LIMIT_ACTION } from './device-rate-limit.guard';
import type { PosDevice } from './device.guard';
import { posReference } from './paytef';
import {
  RECEPTION_LIMIT_MESSAGES,
  RECEPTION_LIMIT_WINDOW_MS,
  receptionCaps,
  receptionLimitHit,
} from './reception-limits';

/** Lo que necesita el datáfono para cobrar la recarga con tarjeta en su lector. */
export interface ReceptionCardSale {
  paymentId: string;
  /** Referencia para la venta de Paytef (la que vuelve en el resultado). */
  reference: string;
  amountCents: number;
  walletId: string;
}

/**
 * El resultado de una recarga con tarjeta que cobró este datáfono (solo
 * lectura): vale también para la ficha de un saldo que ya existía.
 *  - CREDITED: sumada al saldo (balanceCents es lo que tiene ahora);
 *  - PENDING: cobrada en el lector y pendiente de la prueba de Paytef (no sumada);
 *  - OPEN: aún sin cobrar en el lector;
 *  - NOT_PAID: caducada, cancelada o dada por no cobrada.
 */
export interface ReceptionTopUpView {
  paymentId: string;
  status: 'CREDITED' | 'PENDING' | 'OPEN' | 'NOT_PAID';
  amountCents: number;
  walletId: string;
  /** «K7Q-•••»: el código entero solo sale en el saldo recién creado aquí. */
  codeHint: string;
  balanceCents: number | null;
  hasPin: boolean;
  hasCard: boolean;
}

/** El resultado de una recarga se puede mirar en el datáfono que la cobró durante esto. */
const TOP_UP_VIEW_MS = 60 * 60 * 1000;

const NOT_RECEPTION =
  'Este datáfono no es el de la recepción: el efectivo solo se cobra en el que el dueño marca como «Recepción» (Datáfonos)';
const SALE_NOT_OPEN = 'Esta recarga ya se cobró, caducó o se canceló: empieza otra';

const STATUS_VIEW: Record<string, ReceptionTopUpView['status']> = {
  AUTHORIZED: 'CREDITED',
  PARTIALLY_REFUNDED: 'CREDITED',
  REFUNDED: 'CREDITED',
  AUTHORIZING: 'PENDING',
  ORPHAN: 'PENDING',
  CREATED: 'OPEN',
  AWAITING_CAPTURE: 'OPEN',
};

/**
 * Recepción en el datáfono (Authorization: Device): recargar el saldo con
 * tarjeta (venta de Paytef en el propio datáfono) o en efectivo. El datáfono
 * actúa como el local: no hay persona. Por eso:
 *  - la recarga con tarjeta es un cobro sin creador (createdByUserId null) del
 *    datáfono (terminalId), y la de efectivo lleva su terminalId;
 *  - el PIN que elige el cliente en su teclado es suyo (no lo «puso el personal»);
 *  - el efectivo pide el permiso de los datáfonos (Ajustes → Permisos) además
 *    de «Saldo» y «Recarga en efectivo» encendidos, y solo en el datáfono
 *    marcado como el de la recepción (los de las chicas, no);
 *  - con la ficha, «Fichas NFC» encendido;
 *  - topes de 24 h por datáfono y por saldo (reception-limits), y por minuto
 *    por datáfono (DeviceRateLimitGuard): pasarlos queda en Incidencias.
 * Atribuirlo a una persona (quien vinculó el datáfono, el dueño) sería falso
 * y rompería la regla de las dos personas del PIN.
 */
@Injectable()
export class PosDeviceReceptionService {
  private readonly logger = new Logger(PosDeviceReceptionService.name);
  private readonly prisma: PrismaService;
  private readonly payments: PaymentsService;
  private readonly cash: CashTopUpService;
  private readonly audit: AuditService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(CashTopUpService) cash: CashTopUpService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.payments = payments;
    this.cash = cash;
    this.audit = audit;
    this.cls = cls;
  }

  /** Qué ofrece la recepción en este datáfono (lo apagado no sale en la pantalla). */
  async options(device: PosDevice): Promise<ReceptionOptions> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({ where: { id: device.tenantId }, select: { paymentMethods: true, ...VENUE_PAUSE_SELECT } }),
    );
    const methods = paymentMethodsOf(venue?.paymentMethods);
    const open = venuePauseScope(venue) === null;
    const cashBlockedReason = (await this.isReceptionTerminal(device))
      ? await this.cash.cashBlockedReason(device.tenantId, { terminalId: device.terminalId })
      : NOT_RECEPTION;
    return {
      card: open && methods.pos && methods.wallet,
      cash: cashBlockedReason === null,
      cashBlockedReason,
      nfc: methods.nfc,
    };
  }

  /** Recarga en efectivo: sumada al momento, con este datáfono como quien la cobró. */
  async cashTopUp(device: PosDevice, body: CashTopUpDto): Promise<CashTopUpResult> {
    if (!(await this.isReceptionTerminal(device))) throw new ForbiddenException(NOT_RECEPTION);
    await this.assertNfcForCard(device, body.wallet);
    // El mismo botón otra vez la devuelve tal cual (CashTopUpService): sin volver a contar el tope.
    if (!(await this.cashAlreadyTaken(device, body.idempotencyKey))) {
      const walletId = 'create' in body.wallet ? null : (await topUpTarget(this.prisma, device.tenantId, body.wallet)).id;
      await this.assertWithinLimits(device, { amountCents: body.amountCents, walletId, method: 'cash' });
    }
    return this.cash.topUp(device.tenantId, { terminalId: device.terminalId }, body);
  }

  /**
   * Recarga con tarjeta: crea la recarga (saldo nuevo o el de la ficha) como
   * cobro de este datáfono y la deja «empezada» aquí, para que solo este
   * datáfono pueda cobrarla en su lector (/charges/:id/result). Se suma al
   * saldo cuando Paytef confirma la venta aprobada, en la misma transacción.
   * La misma Idempotency-Key otra vez devuelve la venta solo si sigue abierta.
   */
  async cardTopUp(device: PosDevice, body: DeviceCardTopUpDto): Promise<ReceptionCardSale> {
    const idempotencyKey = `reception:${device.terminalId}:${body.idempotencyKey}`;
    const existing = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: device.tenantId, idempotencyKey } },
        select: { status: true, qrExpiresAt: true },
      }),
    );
    if (existing && (String(existing.status) !== 'CREATED' || existing.qrExpiresAt <= new Date())) {
      throw new ConflictException(SALE_NOT_OPEN);
    }
    let wallet: { create: true } | { walletId: string };
    if ('card' in body.wallet) {
      await this.assertNfcForCard(device, body.wallet);
      const target = await topUpTarget(this.prisma, device.tenantId, body.wallet);
      // Las recargas con tarjeta (y su devolución a la tarjeta) son del local del saldo.
      if (target.tenantId !== device.tenantId) {
        throw new ConflictException('Este saldo es de otro local del grupo: aquí, recárgalo en efectivo');
      }
      wallet = { walletId: target.id };
    } else {
      wallet = { create: true };
    }
    if (!existing) {
      await this.assertWithinLimits(device, {
        amountCents: body.amountCents,
        walletId: 'walletId' in wallet ? wallet.walletId : null,
        method: 'card',
      });
    }
    const created = await this.payments.create(
      device.tenantId,
      idempotencyKey,
      { amountCents: body.amountCents, currency: 'EUR', wallet },
      undefined,
      { viaDevice: { terminalId: device.terminalId } },
    );
    if (!created.walletId) throw new ConflictException('No se pudo preparar la recarga: inténtalo otra vez');
    await this.prisma.asSystem((tx) =>
      tx.paymentEvent.create({
        data: {
          paymentId: created.id,
          tenantId: device.tenantId,
          eventType: 'pos.device_started',
          payload: { terminalId: device.terminalId, reception: true },
          traceId: this.cls.get('ctx')?.traceId ?? randomUUID(),
        },
      }),
    );
    if (!existing) {
      await this.audit.log({
        action: 'wallet.reception_card_topup',
        tenantId: device.tenantId,
        targetType: 'Payment',
        targetId: created.id,
        payload: { terminalId: device.terminalId, amountCents: body.amountCents, walletId: created.walletId, newWallet: 'create' in wallet },
      });
      this.logger.log(`Recarga ${created.id} de ${body.amountCents}c en la recepción del datáfono ${device.terminalId}`);
    }
    return { paymentId: created.id, reference: posReference(created.id), amountCents: created.amountCents, walletId: created.walletId };
  }

  /**
   * Cómo quedó una recarga con tarjeta que cobró ESTE datáfono (en la última
   * hora), también la de un saldo que ya existía: sumada, pendiente de Paytef
   * o sin cobrar. Solo lectura: no da el código entero ni deja tocar el saldo.
   */
  async topUpResult(device: PosDevice, paymentId: string): Promise<ReceptionTopUpView> {
    const p = await this.prisma.asSystem((tx) =>
      tx.payment.findFirst({
        where: {
          id: paymentId,
          tenantId: device.tenantId,
          terminalId: device.terminalId,
          createdByUserId: null,
          captureMethod: 'WALLET_TOPUP',
          createdAt: { gte: new Date(Date.now() - TOP_UP_VIEW_MS) },
        },
        select: { id: true, status: true, amountCents: true, walletId: true },
      }),
    );
    const walletId = p?.walletId;
    if (!p || !walletId) throw new NotFoundException('Recarga no encontrada en este datáfono');
    const [w, cards] = await Promise.all([
      this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findUnique({ where: { id: walletId }, select: { shortCode: true, balanceCents: true, pinHash: true } }),
      ),
      this.prisma.acrossVenues((tx) => tx.walletCard.count({ where: { walletId, status: 'ISSUED' } })),
    ]);
    const status = STATUS_VIEW[String(p.status)] ?? 'NOT_PAID';
    return {
      paymentId: p.id,
      status,
      amountCents: p.amountCents,
      walletId,
      codeHint: codeHintOf(w?.shortCode ?? null),
      balanceCents: status === 'CREDITED' ? (w?.balanceCents ?? null) : null,
      hasPin: Boolean(w?.pinHash),
      hasCard: cards > 0,
    };
  }

  // ─── Auxiliares ────────────────────────────────────────────────────────

  private async isReceptionTerminal(device: PosDevice): Promise<boolean> {
    const t = await this.prisma.asSystem((tx) =>
      tx.terminal.findFirst({ where: { id: device.terminalId, tenantId: device.tenantId }, select: { reception: true } }),
    );
    return t?.reception === true;
  }

  /** Recargar la ficha acercada necesita «Fichas NFC» encendido (409 si no). */
  private async assertNfcForCard(device: PosDevice, wallet: TopUpWalletDto): Promise<void> {
    if (!('card' in wallet)) return;
    await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, device.tenantId, ['nfc']));
  }

  private async cashAlreadyTaken(device: PosDevice, idempotencyKey: string): Promise<boolean> {
    const n = await this.prisma.asSystem((tx) =>
      tx.walletCashTopUp.count({ where: { tenantId: device.tenantId, idempotencyKey, terminalId: device.terminalId } }),
    );
    return n > 0;
  }

  /**
   * Topes de 24 h: lo que ha cargado este datáfono (tarjeta y efectivo) y lo
   * que ha recibido el saldo por cualquier vía. Pasarlos → 409 y queda en
   * Incidencias (pos_reception_limit). Las recargas con tarjeta cuentan desde
   * que se piden (salvo las caducadas, canceladas o no cobradas).
   */
  private async assertWithinLimits(
    device: PosDevice,
    sale: { amountCents: number; walletId: string | null; method: 'card' | 'cash' },
  ): Promise<void> {
    const since = new Date(Date.now() - RECEPTION_LIMIT_WINDOW_MS);
    const used = await this.prisma.asSystem(async (tx) => {
      const [terminal] = await tx.$queryRaw<Array<{ cents: number }>>`
        SELECT (
          COALESCE((SELECT SUM("amountCents") FROM payments
                     WHERE "tenantId" = ${device.tenantId}::uuid AND "terminalId" = ${device.terminalId}::uuid
                       AND "captureMethod" = 'WALLET_TOPUP' AND "createdByUserId" IS NULL
                       AND "createdAt" >= ${since}
                       AND status::text NOT IN ('EXPIRED', 'CANCELED', 'FAILED')), 0)
          + COALESCE((SELECT SUM("amountCents") FROM wallet_cash_topups
                       WHERE "terminalId" = ${device.terminalId}::uuid AND "createdAt" >= ${since}), 0)
        )::int AS cents
      `;
      if (!sale.walletId) return { terminal: terminal?.cents ?? 0, wallet: null };
      const [wallet] = await tx.$queryRaw<Array<{ cents: number }>>`
        SELECT (
          COALESCE((SELECT SUM("amountCents") FROM payments
                     WHERE "walletId" = ${sale.walletId}::uuid AND "captureMethod" = 'WALLET_TOPUP'
                       AND "createdAt" >= ${since}
                       AND status::text NOT IN ('EXPIRED', 'CANCELED', 'FAILED')), 0)
          + COALESCE((SELECT SUM("amountCents") FROM wallet_cash_topups
                       WHERE "walletId" = ${sale.walletId}::uuid AND "createdAt" >= ${since}), 0)
        )::int AS cents
      `;
      return { terminal: terminal?.cents ?? 0, wallet: wallet?.cents ?? 0 };
    });
    const caps = receptionCaps();
    const hit = receptionLimitHit({
      amountCents: sale.amountCents,
      terminalUsedCents: used.terminal,
      walletUsedCents: used.wallet,
      caps,
    });
    if (!hit) return;
    this.logger.warn(`Tope ${hit} en el datáfono ${device.terminalId}: ${sale.amountCents}c (${sale.method}) no cobrados`);
    await this.audit.log({
      action: RECEPTION_LIMIT_ACTION,
      tenantId: device.tenantId,
      targetType: 'Terminal',
      targetId: device.terminalId,
      payload: {
        limit: hit,
        method: sale.method,
        amountCents: sale.amountCents,
        usedCents: hit === 'terminal_daily' ? used.terminal : used.wallet,
        capCents: hit === 'terminal_daily' ? caps.terminalCents : caps.walletCents,
        walletId: sale.walletId,
        terminalLabel: device.label,
      },
    });
    throw new ConflictException({ message: RECEPTION_LIMIT_MESSAGES[hit], code: 'RECEPTION_LIMIT', limit: hit });
  }
}
