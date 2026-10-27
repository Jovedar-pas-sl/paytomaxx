import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  formatMoney,
  settlementPendingCents,
  type GenerateSettlementDto,
  type OxioPayPayee,
  type RecordSettlementPaymentDto,
  type SetOxioPayPayeeDto,
  type SettlementDetail,
  type SettlementListQuery,
  type SuperAdminSettlementPage,
  type VoidSettlementDto,
} from '@nightpay/contracts';
import { OxioPaySettlementsService, weekFromMonday } from '../oxiopay-settlements/oxiopay-settlements.service';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import type { SuperAdminActor } from './superadmin.guard';

/**
 * «Liquidaciones OxioPay» desde la consola: todas, con filtros y lo pendiente
 * de cobrar; apuntar lo recibido, anular, generar (o regenerar tras anular) y
 * la cuenta de OxioPay. Cada escritura pide el 2FA del super-admin y queda en
 * el registro (`superadmin.settlement.*`, el IBAN tapado).
 */
@Injectable()
export class SuperAdminSettlementsService {
  private readonly settlements: OxioPaySettlementsService;
  private readonly stepUp: SuperAdminStepUpService;
  private readonly audit: SuperAdminAuditService;

  constructor(
    @Inject(OxioPaySettlementsService) settlements: OxioPaySettlementsService,
    @Inject(SuperAdminStepUpService) stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) audit: SuperAdminAuditService,
  ) {
    this.settlements = settlements;
    this.stepUp = stepUp;
    this.audit = audit;
  }

  list(query: SettlementListQuery, now: Date = new Date()): Promise<SuperAdminSettlementPage> {
    return this.settlements.listForSuperAdmin(query, now);
  }

  get(id: string, now: Date = new Date()): Promise<SettlementDetail> {
    return this.settlements.detailForSuperAdmin(id, now);
  }

  /** Lo recibido por transferencia (2FA; motivo si no es lo pendiente). Lo que falte queda pendiente. */
  async recordPayment(actor: SuperAdminActor, id: string, dto: RecordSettlementPaymentDto, now: Date = new Date()): Promise<SettlementDetail> {
    await this.stepUp.verify(actor, dto.totpCode, 'settlement.pay');
    const { totpCode: _code, ...payment } = dto;
    const { before, after, paymentId } = await this.settlements.recordPayment(actor, id, payment, now);
    const pendingBefore = settlementPendingCents(before);
    await this.audit.write(actor, {
      action: after.status === 'PAID' ? 'settlement.paid' : 'settlement.paid_partially',
      tenantId: after.tenantId,
      targetType: 'OxioPaySettlement',
      targetId: id,
      before: { status: before.status, paidCents: before.paidCents },
      after: { status: after.status, paidCents: after.paidCents },
      reason: payment.reason ?? null,
      extra: {
        reference: after.reference,
        paymentId,
        amountCents: payment.amountCents,
        paidOn: payment.paidOn,
        bankReference: payment.bankReference,
        pendingBeforeCents: pendingBefore,
        matchesPending: payment.amountCents === pendingBefore,
      },
    });
    return this.settlements.detailForSuperAdmin(id, now);
  }

  /** Anular (solo sin pagos; 2FA y motivo). Se puede regenerar después. */
  async void(actor: SuperAdminActor, id: string, dto: VoidSettlementDto, now: Date = new Date()): Promise<SettlementDetail> {
    await this.stepUp.verify(actor, dto.totpCode, 'settlement.void');
    const { before, after } = await this.settlements.voidSettlement(actor, id, dto.reason, now);
    await this.audit.write(actor, {
      action: 'settlement.voided',
      tenantId: after.tenantId,
      targetType: 'OxioPaySettlement',
      targetId: id,
      before: { status: before.status },
      after: { status: after.status },
      reason: dto.reason,
      extra: { reference: after.reference, totalCents: after.totalCents },
    });
    return this.settlements.detailForSuperAdmin(id, now);
  }

  /** Generar la de un local y una semana ya terminada (o regenerarla tras anularla), con 2FA. */
  async generate(actor: SuperAdminActor, dto: GenerateSettlementDto, now: Date = new Date()): Promise<SettlementDetail> {
    const week = weekFromMonday(dto.week);
    await this.stepUp.verify(actor, dto.totpCode, 'settlement.generate');
    const outcome = await this.settlements.generate(dto.venueId, week, { now, auto: false, actor });
    if (outcome.kind === 'exists') {
      throw new ConflictException({
        message: `Ya hay una liquidación de esa semana (${outcome.reference}). Para rehacerla, anúlala antes.`,
        code: 'SETTLEMENT_EXISTS',
        settlementId: outcome.id,
      });
    }
    if (outcome.kind !== 'created') {
      // 'voided' solo lo da el repaso automático; a mano se regenera.
      const total = outcome.kind === 'nothing' ? outcome.totalCents : 0;
      throw new ConflictException({ message: `Esa semana no tiene nada que liquidar (${formatMoney(total)}).`, code: 'SETTLEMENT_NOTHING' });
    }
    await this.audit.write(actor, {
      action: outcome.replacesId ? 'settlement.regenerated' : 'settlement.generated',
      tenantId: dto.venueId,
      targetType: 'OxioPaySettlement',
      targetId: outcome.id,
      reason: dto.reason ?? null,
      extra: { auto: false, reference: outcome.reference, week: week.monday, totalCents: outcome.totalCents, replacesId: outcome.replacesId },
    });
    return this.settlements.detailForSuperAdmin(outcome.id, now);
  }

  payee(): Promise<OxioPayPayee | null> {
    return this.settlements.payee();
  }

  /** La cuenta de OxioPay para las transferencias (IBAN mod-97; 2FA). En el registro, tapada. */
  async setPayee(actor: SuperAdminActor, dto: SetOxioPayPayeeDto): Promise<OxioPayPayee> {
    await this.stepUp.verify(actor, dto.totpCode, 'settlement.payee');
    const { totpCode: _code, ...payee } = dto;
    const { before, after } = await this.settlements.setPayee(actor, payee);
    await this.audit.write(actor, {
      action: 'settlement.payee_updated',
      targetType: 'OxioPayPayee',
      targetId: '1',
      before: before ? { name: before.name, iban: before.iban, holder: before.holder } : null,
      after: { name: after.name, iban: after.iban, holder: after.holder },
    });
    return after;
  }
}
