import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  formatMoney,
  maskIban,
  settlementPendingCents,
  type GenerateSettlementDto,
  type OxioPayPayee,
  type RecordSettlementPaymentDto,
  type SetOxioPayPayeeDto,
  type SetSettlementStartDto,
  type SettlementDetail,
  type SettlementListQuery,
  type SuperAdminSettlementPage,
  type VoidSettlementDto,
} from '@nightpay/contracts';
import { TelegramService } from '../incidents/telegram.service';
import { OxioPaySettlementsService, weekFromMonday } from '../oxiopay-settlements/oxiopay-settlements.service';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import type { SuperAdminActor } from './superadmin.guard';

/** El aviso de Telegram de un cambio de la cuenta de OxioPay (IBAN tapado). */
export function payeeChangedMessage(actor: SuperAdminActor, before: OxioPayPayee | null, after: OxioPayPayee): string {
  return [
    'OxioPay · Cuenta de OxioPay cambiada',
    `Por ${actor.email}${actor.ip ? ` (IP ${actor.ip})` : ''}.`,
    `Ahora: ${after.holder} · ${maskIban(after.iban)}${before ? ` (antes: ${before.holder} · ${maskIban(before.iban)})` : ' (antes: sin cuenta)'}.`,
    'Todas las liquidaciones sin pagar dicen ahora que se pague a esta cuenta. Si no has sido tú, revísalo ya.',
  ].join('\n');
}

/**
 * «Liquidaciones OxioPay» desde la consola: todas, con filtros, lo pendiente
 * de cobrar y la semana de inicio; apuntar lo recibido, anular, generar (o
 * regenerar tras anular), la cuenta de OxioPay y la semana de inicio. Lo que
 * no va a valer se rechaza ANTES de pedir el 2FA; cada escritura pide el 2FA
 * del super-admin y deja su registro (`superadmin.settlement.*`, el IBAN
 * tapado) en la MISMA transacción: sin registro no hay cambio.
 */
@Injectable()
export class SuperAdminSettlementsService {
  private readonly logger = new Logger(SuperAdminSettlementsService.name);
  private readonly settlements: OxioPaySettlementsService;
  private readonly stepUp: SuperAdminStepUpService;
  private readonly audit: SuperAdminAuditService;
  private readonly telegram: TelegramService;

  constructor(
    @Inject(OxioPaySettlementsService) settlements: OxioPaySettlementsService,
    @Inject(SuperAdminStepUpService) stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) audit: SuperAdminAuditService,
    @Inject(TelegramService) telegram: TelegramService,
  ) {
    this.settlements = settlements;
    this.stepUp = stepUp;
    this.audit = audit;
    this.telegram = telegram;
  }

  list(query: SettlementListQuery, now: Date = new Date()): Promise<SuperAdminSettlementPage> {
    return this.settlements.listForSuperAdmin(query, now);
  }

  get(id: string, now: Date = new Date()): Promise<SettlementDetail> {
    return this.settlements.detailForSuperAdmin(id, now);
  }

  /** Lo recibido por transferencia (2FA; motivo si no es lo pendiente; la misma referencia del banco, solo confirmándolo). */
  async recordPayment(actor: SuperAdminActor, id: string, dto: RecordSettlementPaymentDto, now: Date = new Date()): Promise<SettlementDetail> {
    const { totpCode, ...payment } = dto;
    await this.settlements.paymentPrecheck(id, payment, now);
    await this.stepUp.verify(actor, totpCode, 'settlement.pay');
    await this.settlements.recordPayment(actor, id, payment, now, async (tx, { before, after, paymentId }) => {
      const pendingBefore = settlementPendingCents(before);
      await this.audit.writeInTx(tx, actor, {
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
          ...(payment.confirmDuplicate ? { confirmedDuplicateReference: true } : {}),
        },
      });
    });
    return this.settlements.detailForSuperAdmin(id, now);
  }

  /** Anular (solo sin pagos; 2FA y motivo). Se puede regenerar después. */
  async void(actor: SuperAdminActor, id: string, dto: VoidSettlementDto, now: Date = new Date()): Promise<SettlementDetail> {
    await this.settlements.voidPrecheck(id);
    await this.stepUp.verify(actor, dto.totpCode, 'settlement.void');
    await this.settlements.voidSettlement(actor, id, dto.reason, now, (tx, { before, after }) =>
      this.audit.writeInTx(tx, actor, {
        action: 'settlement.voided',
        tenantId: after.tenantId,
        targetType: 'OxioPaySettlement',
        targetId: id,
        before: { status: before.status },
        after: { status: after.status },
        reason: dto.reason,
        extra: { reference: after.reference, totalCents: after.totalCents },
      }),
    );
    return this.settlements.detailForSuperAdmin(id, now);
  }

  /** Generar la de un local y una semana ya terminada desde la de inicio (o regenerarla tras anularla), con 2FA. */
  async generate(actor: SuperAdminActor, dto: GenerateSettlementDto, now: Date = new Date()): Promise<SettlementDetail> {
    const week = weekFromMonday(dto.week);
    await this.settlements.generationStart(week, now);
    await this.stepUp.verify(actor, dto.totpCode, 'settlement.generate');
    const outcome = await this.settlements.generate(dto.venueId, week, {
      now,
      auto: false,
      actor,
      onWrite: (tx, row) =>
        this.audit.writeInTx(tx, actor, {
          action: row.replacesId ? 'settlement.regenerated' : 'settlement.generated',
          tenantId: dto.venueId,
          targetType: 'OxioPaySettlement',
          targetId: row.id,
          reason: dto.reason ?? null,
          extra: { auto: false, reference: row.reference, week: week.monday, totalCents: row.totalCents, replacesId: row.replacesId },
        }),
    });
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
    return this.settlements.detailForSuperAdmin(outcome.id, now);
  }

  payee(): Promise<OxioPayPayee | null> {
    return this.settlements.payee();
  }

  /**
   * La cuenta de OxioPay para las transferencias (IBAN mod-97; 2FA). Al
   * registro en la misma transacción (tapado) y aviso por Telegram: redirige
   * todas las transferencias de todos los locales.
   */
  async setPayee(actor: SuperAdminActor, dto: SetOxioPayPayeeDto): Promise<OxioPayPayee> {
    const { totpCode, ...payee } = dto;
    await this.stepUp.verify(actor, totpCode, 'settlement.payee');
    const { before, after } = await this.settlements.setPayee(actor, payee, (tx, change) =>
      this.audit.writeInTx(tx, actor, {
        action: 'settlement.payee_updated',
        targetType: 'OxioPayPayee',
        targetId: '1',
        before: change.before ? { name: change.before.name, iban: change.before.iban, holder: change.before.holder } : null,
        after: { name: change.after.name, iban: change.after.iban, holder: change.after.holder },
      }),
    );
    try {
      const sent = await this.telegram.send(payeeChangedMessage(actor, before, after));
      if (!sent) this.logger.warn('Cuenta de OxioPay cambiada: el aviso por Telegram no salió (sin bot o sin chat)');
    } catch (err) {
      this.logger.error(`Cuenta de OxioPay cambiada: el aviso por Telegram falló: ${(err as Error).message}`);
    }
    return after;
  }

  async settings(): Promise<{ startWeek: string | null }> {
    return { startWeek: (await this.settlements.startWeek())?.monday ?? null };
  }

  /** La semana de inicio de las liquidaciones (lunes; 2FA y motivo). */
  async setStartWeek(actor: SuperAdminActor, dto: SetSettlementStartDto): Promise<{ startWeek: string }> {
    await this.stepUp.verify(actor, dto.totpCode, 'settlement.start_week');
    const { after } = await this.settlements.setStartWeek(actor, dto.startWeek, (tx, change) =>
      this.audit.writeInTx(tx, actor, {
        action: 'settlement.start_week_updated',
        targetType: 'OxioPaySettlementSettings',
        targetId: '1',
        before: { startWeek: change.before },
        after: { startWeek: change.after },
        reason: dto.reason,
      }),
    );
    return { startWeek: after };
  }
}
