import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  maskPayoutAddress,
  type PayoutAccountFull,
  type PayoutAccountListItem,
  type PayoutAccountListQuery,
  type PayoutMetadata,
  type PayoutMethod,
  type StepUpWithReasonDto,
  type UpdatePayoutAccountDto,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { payoutRoutingChanges } from '../operators/payout-routing';
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
  updatedAt: true,
  venue: { select: { id: true, name: true } },
} as const;
type AccountRow = Prisma.UserGetPayload<{ select: typeof accountSelect }>;

/**
 * Cuentas de cobro de las chicas de todos los locales. La lista va tapada;
 * verla entera pide 2FA y queda en el registro; cambiarla pide 2FA y motivo
 * (validada según el método con las mismas reglas que el panel y el enlace
 * de la chica: payoutAddressProblem / payoutRoutingChanges).
 */
@Injectable()
export class SuperAdminPayoutAccountsService {
  private readonly prisma: PrismaService;
  private readonly stepUp: SuperAdminStepUpService;
  private readonly audit: SuperAdminAuditService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(SuperAdminStepUpService) stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) audit: SuperAdminAuditService,
  ) {
    this.prisma = prisma;
    this.stepUp = stepUp;
    this.audit = audit;
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
    await this.audit.write(actor, {
      action: 'payout_account.revealed',
      tenantId: row.tenantId,
      targetType: 'User',
      targetId: userId,
      reason: dto.reason,
      extra: { payoutMethod: row.payoutMethod, payoutAddress: row.payoutAddress },
    });
    return {
      userId: row.id,
      payoutMethod: (row.payoutMethod as PayoutMethod | null) ?? null,
      payoutAddress: row.payoutAddress,
      payoutLabel: row.payoutLabel,
      payoutMetadata: (row.payoutMetadata as PayoutMetadata | null) ?? null,
    };
  }

  /** Cambiar (o quitar, con los dos a null) la cuenta de cobro (2FA + motivo). */
  async update(actor: SuperAdminActor, userId: string, dto: UpdatePayoutAccountDto): Promise<PayoutAccountListItem> {
    await this.stepUp.verify(actor, dto.totpCode, 'payout_account.update');
    const before = await this.load(userId);
    // Valida y normaliza (IBAN sin espacios) como el panel; 400 si no cuadra.
    const routing = payoutRoutingChanges(before, { payoutMethod: dto.payoutMethod, payoutAddress: dto.payoutAddress });
    const data: Prisma.UserUpdateInput = {
      ...routing,
      ...(dto.payoutLabel !== undefined ? { payoutLabel: dto.payoutLabel } : {}),
      ...(dto.payoutMetadata !== undefined
        ? { payoutMetadata: dto.payoutMetadata === null ? Prisma.DbNull : (dto.payoutMetadata as Prisma.InputJsonValue) }
        : {}),
    };
    const after = await this.prisma.acrossVenues((tx) => tx.user.update({ where: { id: userId }, data, select: accountSelect }));
    await this.audit.write(actor, {
      action: 'payout_account.updated',
      tenantId: before.tenantId,
      targetType: 'User',
      targetId: userId,
      before: accountOf(before),
      after: accountOf(after),
      reason: dto.reason,
    });
    return toListItem(after);
  }

  private async load(userId: string): Promise<AccountRow> {
    const row = await this.prisma.acrossVenues((tx) =>
      tx.user.findFirst({ where: { id: userId, role: 'OPERATOR' }, select: accountSelect }),
    );
    if (!row) throw new NotFoundException(OPERATOR_NOT_FOUND);
    return row;
  }
}

function accountOf(row: AccountRow) {
  return { payoutMethod: row.payoutMethod, payoutAddress: row.payoutAddress, payoutLabel: row.payoutLabel };
}

export function toListItem(row: AccountRow): PayoutAccountListItem {
  return {
    userId: row.id,
    displayName: row.displayName,
    email: row.email,
    venue: row.venue,
    active: row.deletedAt === null,
    payoutMethod: (row.payoutMethod as PayoutMethod | null) ?? null,
    payoutAddressMasked: maskPayoutAddress(row.payoutMethod, row.payoutAddress),
    payoutLabel: row.payoutLabel,
    hasPayoutAccount: Boolean(row.payoutMethod && row.payoutAddress),
    updatedAt: row.updatedAt.toISOString(),
  };
}
