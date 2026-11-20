import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  maskHolderName,
  type PayoutAccountFull,
  type PayoutAccountListItem,
  type PayoutAccountListQuery,
  type PayoutMethod,
  type StepUpWithReasonDto,
  type UpdatePayoutAccountDto,
} from '@nightpay/contracts';
import { EmailService } from '../../common/email/email.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  maskedPayoutAccount,
  openPayoutAccount,
  payoutAccountChangedMeanwhile,
  planPayoutAccountChange,
  type OpenPayoutAccount,
} from '../operators/payout-account';
import { notifyPayoutAccountChanged } from '../operators/payout-account-notices';
import { isRecordNotFound } from '../operators/self-onboarding-token';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import type { SuperAdminActor } from './superadmin.guard';

const OPERATOR_NOT_FOUND = 'Chica no encontrada';
const MAX_LIST = 1000;

const accountSelect = {
  id: true,
  tenantId: true,
  email: true,
  displayName: true,
  deletedAt: true,
  payoutMethod: true,
  payoutAddress: true,
  payoutLabel: true,
  payoutMetadata: true,
  payoutAddressMasked: true,
  payoutHolderMasked: true,
  payoutAccountChangedAt: true,
  payoutHoldUntil: true,
  updatedAt: true,
  venue: { select: { id: true, name: true } },
} as const;
type AccountRow = Prisma.UserGetPayload<{ select: typeof accountSelect }>;

/**
 * Cuentas de cobro de las chicas de todos los locales. La lista va tapada;
 * verla entera pide 2FA y queda en el registro; cambiarla pide 2FA y motivo
 * (validada según el método con las mismas reglas que el panel y el enlace
 * de la chica: planPayoutAccountChange). Se guarda cifrada y tapada aparte;
 * al cambiarla, aviso al local (Incidencias y Telegram) y correo a ella.
 */
@Injectable()
export class SuperAdminPayoutAccountsService {
  private readonly logger = new Logger(SuperAdminPayoutAccountsService.name);
  private readonly prisma: PrismaService;
  private readonly stepUp: SuperAdminStepUpService;
  private readonly audit: SuperAdminAuditService;
  /** El registro del local (operator.payout_account_changed) y el correo a ella. */
  private readonly venueAudit: AuditService;
  private readonly email: EmailService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(SuperAdminStepUpService) stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) audit: SuperAdminAuditService,
    @Inject(AuditService) venueAudit: AuditService,
    @Inject(EmailService) email: EmailService,
  ) {
    this.prisma = prisma;
    this.stepUp = stepUp;
    this.audit = audit;
    this.venueAudit = venueAudit;
    this.email = email;
  }

  async list(query: PayoutAccountListQuery): Promise<PayoutAccountListItem[]> {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      role: 'OPERATOR',
      ...(query.includeInactive ? {} : { deletedAt: null }),
      ...(query.venueId ? { tenantId: query.venueId } : {}),
      ...(query.method ? { payoutMethod: query.method } : {}),
      ...(query.missing ? { payoutAddress: null } : {}),
      ...(q
        ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { displayName: { contains: q, mode: 'insensitive' } }] }
        : {}),
    };
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.user.findMany({
        where,
        select: accountSelect,
        orderBy: [{ tenantId: 'asc' }, { displayName: 'asc' }, { email: 'asc' }],
        take: MAX_LIST,
      }),
    );
    return rows.map(toListItem);
  }

  /** La cuenta entera (2FA): queda en el registro quién la vio y por qué. */
  async reveal(actor: SuperAdminActor, userId: string, dto: StepUpWithReasonDto): Promise<PayoutAccountFull> {
    await this.stepUp.verify(actor, dto.totpCode, 'payout_account.reveal');
    const row = await this.load(userId);
    const account = this.open(row);
    // La de verdad: SuperAdminAuditService la tapa (maskSensitive), nunca la cifrada.
    await this.audit.write(actor, {
      action: 'payout_account.revealed',
      tenantId: row.tenantId,
      targetType: 'User',
      targetId: userId,
      reason: dto.reason,
      extra: { payoutMethod: account.method, payoutAddress: account.address },
    });
    return {
      userId: row.id,
      payoutMethod: account.method,
      payoutAddress: account.address,
      payoutLabel: account.label,
      payoutMetadata: account.metadata,
    };
  }

  /** Cambiar (o quitar, con los dos a null) la cuenta de cobro (2FA + motivo). */
  async update(actor: SuperAdminActor, userId: string, dto: UpdatePayoutAccountDto): Promise<PayoutAccountListItem> {
    await this.stepUp.verify(actor, dto.totpCode, 'payout_account.update');
    const before = await this.load(userId);
    // Valida y normaliza (IBAN sin espacios) como el panel, con titular en SEPA
    // y SWIFT; 400 si no cuadra. Cifrada y tapada aparte; 48 h a la nueva.
    const plan = planPayoutAccountChange(
      before,
      { method: dto.payoutMethod, address: dto.payoutAddress, label: dto.payoutLabel, metadata: dto.payoutMetadata },
      new Date(),
    );
    // Solo si sigue como se leyó: si el dueño la cambió a la vez, no se pisa (409).
    const after = await this.prisma
      .acrossVenues((tx) => tx.user.update({ where: { id: userId, ...plan.ifUnchanged }, data: plan.data, select: accountSelect }))
      .catch((err: unknown) => {
        throw isRecordNotFound(err) ? payoutAccountChangedMeanwhile() : err;
      });
    await this.audit.write(actor, {
      action: 'payout_account.updated',
      tenantId: before.tenantId,
      targetType: 'User',
      targetId: userId,
      before: accountOf(plan.before),
      after: accountOf(plan.after),
      reason: dto.reason,
    });
    if (plan.accountChanged) {
      await notifyPayoutAccountChanged(
        { audit: this.venueAudit, email: this.email, logger: this.logger },
        {
          tenantId: before.tenantId,
          actorId: actor.id,
          via: 'oxiopay',
          operator: { id: before.id, email: before.email, displayName: before.displayName },
          venueName: before.venue.name,
          before: plan.before,
          after: plan.after,
          at: new Date(),
          holdUntil: plan.holdUntil,
        },
      );
    }
    return toListItem(after);
  }

  private open(row: AccountRow): OpenPayoutAccount {
    try {
      return openPayoutAccount(row);
    } catch (err) {
      this.logger.error(`No se puede abrir la cuenta de cobro de ${row.id}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('No se puede leer la cuenta guardada (¿otra ENCRYPTION_KEK?): ponla otra vez entera.');
    }
  }

  private async load(userId: string): Promise<AccountRow> {
    const row = await this.prisma.acrossVenues((tx) =>
      tx.user.findFirst({ where: { id: userId, role: 'OPERATOR' }, select: accountSelect }),
    );
    if (!row) throw new NotFoundException(OPERATOR_NOT_FOUND);
    return row;
  }
}

/** Para el registro de la consola: la cuenta de verdad (maskSensitive la tapa) y el titular ya tapado. */
function accountOf(a: OpenPayoutAccount) {
  return {
    payoutMethod: a.method,
    payoutAddress: a.address,
    payoutLabel: a.label,
    payoutHolder: maskHolderName(a.metadata?.accountHolder),
  };
}

export function toListItem(row: AccountRow): PayoutAccountListItem {
  const masked = maskedPayoutAccount(row);
  return {
    userId: row.id,
    displayName: row.displayName,
    email: row.email,
    venue: row.venue,
    active: row.deletedAt === null,
    payoutMethod: (row.payoutMethod as PayoutMethod | null) ?? null,
    payoutAddressMasked: masked.addressMasked,
    payoutHolderMasked: masked.holderMasked,
    payoutLabel: row.payoutLabel,
    hasPayoutAccount: Boolean(row.payoutMethod && row.payoutAddress),
    updatedAt: row.updatedAt.toISOString(),
  };
}
