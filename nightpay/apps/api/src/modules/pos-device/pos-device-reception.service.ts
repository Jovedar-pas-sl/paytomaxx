import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  paymentMethodsOf,
  type CashTopUpDto,
  type CashTopUpResult,
  type DeviceCardTopUpDto,
  type ReceptionOptions,
} from '@nightpay/contracts';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../common/context/request-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { venuePauseScope, VENUE_PAUSE_SELECT } from '../venues/venue-pause';
import { CashTopUpService } from '../wallets/wallet-cash-topup.service';
import { topUpTarget } from '../wallets/wallet-topup-target';
import type { PosDevice } from './device.guard';
import { posReference } from './paytef';

/** Lo que necesita el datáfono para cobrar la recarga con tarjeta en su lector. */
export interface ReceptionCardSale {
  paymentId: string;
  /** Referencia para la venta de Paytef (la que vuelve en el resultado). */
  reference: string;
  amountCents: number;
  walletId: string;
}

/**
 * Recepción en el datáfono (Authorization: Device): recargar el saldo con
 * tarjeta (venta de Paytef en el propio datáfono) o en efectivo. El datáfono
 * actúa como el local: no hay persona. Por eso:
 *  - la recarga con tarjeta es un cobro sin creador (createdByUserId null) del
 *    datáfono (terminalId), y la de efectivo lleva su terminalId;
 *  - el PIN que elige el cliente en su teclado es suyo (no lo «puso el personal»);
 *  - el efectivo pide el permiso de los datáfonos (Ajustes → Permisos) además
 *    de «Saldo» y «Recarga en efectivo» encendidos.
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
    const cashBlockedReason = await this.cash.cashBlockedReason(device.tenantId, { terminalId: device.terminalId });
    return {
      card: open && methods.pos && methods.wallet,
      cash: cashBlockedReason === null,
      cashBlockedReason,
      nfc: methods.nfc,
    };
  }

  /** Recarga en efectivo: sumada al momento, con este datáfono como quien la cobró. */
  async cashTopUp(device: PosDevice, body: CashTopUpDto): Promise<CashTopUpResult> {
    return this.cash.topUp(device.tenantId, { terminalId: device.terminalId }, body);
  }

  /**
   * Recarga con tarjeta: crea la recarga (saldo nuevo o el de la ficha) como
   * cobro de este datáfono y la deja «empezada» aquí, para que solo este
   * datáfono pueda cobrarla en su lector (/charges/:id/result). Se suma al
   * saldo cuando llega la venta aprobada, en la misma transacción.
   */
  async cardTopUp(device: PosDevice, body: DeviceCardTopUpDto): Promise<ReceptionCardSale> {
    let wallet: { create: true } | { walletId: string };
    if ('card' in body.wallet) {
      const target = await topUpTarget(this.prisma, device.tenantId, body.wallet);
      // Las recargas con tarjeta (y su devolución a la tarjeta) son del local del saldo.
      if (target.tenantId !== device.tenantId) {
        throw new ConflictException('Este saldo es de otro local del grupo: aquí, recárgalo en efectivo');
      }
      wallet = { walletId: target.id };
    } else {
      wallet = { create: true };
    }
    const created = await this.payments.create(
      device.tenantId,
      `reception:${device.terminalId}:${body.idempotencyKey}`,
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
    await this.audit.log({
      action: 'wallet.reception_card_topup',
      tenantId: device.tenantId,
      targetType: 'Payment',
      targetId: created.id,
      payload: { terminalId: device.terminalId, amountCents: body.amountCents, walletId: created.walletId, newWallet: 'create' in wallet },
    });
    this.logger.log(`Recarga ${created.id} de ${body.amountCents}c en la recepción del datáfono ${device.terminalId}`);
    return { paymentId: created.id, reference: posReference(created.id), amountCents: created.amountCents, walletId: created.walletId };
  }
}
