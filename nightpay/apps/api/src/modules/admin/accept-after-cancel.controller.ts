import { stepUpActions, type JwtPayload } from '@nightpay/contracts';
import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TotpService } from '../auth/totp.service';
import { AuditService } from '../audit/audit.service';
import { APPROVAL_UNBOOKED_EVENT } from '../payments/late-card-approval';
import { PAID_AFTER_CANCEL_REASON } from '../payments/paid-after-cancel';
import { InvalidTransitionError } from '../payments/payment.machine';
import { PaymentsService } from '../payments/payments.service';

const PROVIDERS = ['WIPAY', 'PEANPE', 'PAYTEF', 'REDSYS', 'BTCPAY'] as const;
type ApprovalProvider = (typeof PROVIDERS)[number];

export const AcceptAfterCancelSchema = z.object({
  /** El aviso «Pagó después de cancelar» (su id en la bandeja). */
  eventId: z.string().regex(/^\d{1,19}$/, 'Aviso no válido'),
  /** Qué se hizo y por qué (queda en el aviso cerrado y en el registro). */
  note: z.string().trim().min(3, 'Escribe por qué lo das por bueno').max(300),
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
});
type AcceptAfterCancelBody = z.infer<typeof AcceptAfterCancelSchema>;

/**
 * «Dar por bueno» (paid-after-cancel.ts): el banco cobró un cobro que el
 * personal ya había cancelado y el local se lo queda. Solo el encargado o el
 * dueño, con su 2FA (o su llave). El cobro pasa a pagado con el pedido que
 * cobró el banco (su propina y la comisión de la compañera, como un pago normal),
 * el aviso se cierra con la nota y queda en el registro (y en Avisos, como
 * acción delicada). Lo que no es de este caso, 404; ya no cancelado, 409.
 */
@Controller('admin')
@UseGuards(RolesGuard)
export class AcceptAfterCancelController {
  private readonly logger = new Logger(AcceptAfterCancelController.name);
  private readonly prisma: PrismaService;
  private readonly payments: PaymentsService;
  private readonly totp: TotpService;
  private readonly audit: AuditService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(TotpService) totp: TotpService,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.prisma = prisma;
    this.payments = payments;
    this.totp = totp;
    this.audit = audit;
  }

  @Post('payments/:id/accept-after-cancel')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(200)
  async accept(
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(AcceptAfterCancelSchema)) body: AcceptAfterCancelBody,
  ): Promise<{ ok: true; newStatus: 'AUTHORIZED' }> {
    const late = await this.lateApproval(paymentId, tenantId, body.eventId);
    // Antes del 2FA (no gasta un intento): el cobro tiene que seguir cancelado.
    if (late.status !== 'CANCELED') {
      throw new ConflictException('Este cobro ya no está cancelado: no se puede dar por bueno');
    }
    await this.totp.assertForUser(user.sub, body.totpCode, stepUpActions.acceptAfterCancel(paymentId));
    try {
      await this.payments.transition(
        paymentId,
        { type: 'AUTHORIZED', provider: late.provider, providerTxId: late.providerTxId, acceptedAfterCancel: true },
        tenantId,
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new ConflictException('El cobro cambió mientras lo dabas por bueno: vuelve a mirarlo');
      }
      throw err;
    }
    const note = `Dado por bueno: ${body.note}`;
    await this.prisma.incidentAck.upsert({
      where: { tenantId_kind_refId: { tenantId, kind: 'approval_unbooked', refId: body.eventId } },
      create: { tenantId, kind: 'approval_unbooked', refId: body.eventId, ackedBy: user.sub, note },
      update: {},
    });
    await this.audit.log({
      action: 'payment.accepted_after_cancel',
      tenantId,
      actorId: user.sub,
      targetType: 'Payment',
      targetId: paymentId,
      payload: { note: body.note, eventId: body.eventId, providerTxId: late.providerTxId, amountCents: late.amountCents },
    });
    this.logger.warn(`Pagó después de cancelar: ${paymentId} dado por bueno por ${user.sub} (pedido ${late.providerTxId})`);
    return { ok: true, newStatus: 'AUTHORIZED' };
  }

  /** El aviso «Pagó después de cancelar» de este cobro y local, con el estado del cobro ahora. */
  private async lateApproval(
    paymentId: string,
    tenantId: string,
    eventId: string,
  ): Promise<{ status: string; provider: ApprovalProvider; providerTxId: string; amountCents: number | null }> {
    const found = await this.prisma.asSystem(async (tx) => {
      const event = await tx.paymentEvent.findFirst({
        where: { id: BigInt(eventId), paymentId, tenantId, eventType: APPROVAL_UNBOOKED_EVENT },
        select: { payload: true },
      });
      const payment = await tx.payment.findFirst({ where: { id: paymentId, tenantId }, select: { status: true, provider: true } });
      return { event, payment };
    });
    const p = (found.event?.payload ?? null) as Record<string, unknown> | null;
    const provider = (typeof p?.provider === 'string' ? p.provider : found.payment?.provider) as ApprovalProvider | null | undefined;
    if (
      !found.payment ||
      !p ||
      p.reason !== PAID_AFTER_CANCEL_REASON ||
      typeof p.providerTxId !== 'string' ||
      !provider ||
      !PROVIDERS.includes(provider)
    ) {
      throw new NotFoundException('Ese aviso no es de un cobro cancelado y pagado después en este local');
    }
    return {
      status: found.payment.status,
      provider,
      providerTxId: p.providerTxId,
      amountCents: typeof p.amountCents === 'number' ? p.amountCents : null,
    };
  }
}
