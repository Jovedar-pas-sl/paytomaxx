import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApprovalListQuerySchema,
  ApproveApprovalSchema,
  RejectApprovalSchema,
  type ApprovalListQuery,
  type ApprovalListResponse,
  type ApprovalRules,
  type ApprovalView,
  type ApproveApprovalDto,
  type JwtPayload,
  type RejectApprovalDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { ApprovalRequestsService, type ApprovalActor } from './approval-requests.service';
import { ApprovalsService } from './approvals.service';

export function actorOf(user: JwtPayload): ApprovalActor {
  return { userId: user.sub, role: user.role, tenantId: user.tenantId };
}

/**
 * «Por aprobar» (ver docs/APROBACIONES.md).
 *  - GET  /v1/approvals?status=PENDING → el dueño, todas las del local; el encargado, las suyas.
 *  - GET  /v1/approvals/rules          → qué le toca a quien mira (pedir o hacerlo directo).
 *  - POST /v1/approvals/:id/approve    → el dueño, con su 2FA; nunca quien la pidió.
 *  - POST /v1/approvals/:id/reject     → el dueño, con el motivo.
 * Las solicitudes se crean desde los endpoints de siempre (202).
 */
@Controller('approvals')
@UseGuards(RolesGuard)
export class ApprovalsController {
  private readonly requests: ApprovalRequestsService;
  private readonly approvals: ApprovalsService;

  constructor(
    @Inject(ApprovalRequestsService) requests: ApprovalRequestsService,
    @Inject(ApprovalsService) approvals: ApprovalsService,
  ) {
    this.requests = requests;
    this.approvals = approvals;
  }

  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(
    @CurrentUser() user: JwtPayload,
    @Query(new ZodValidationPipe(ApprovalListQuerySchema)) query: ApprovalListQuery,
  ): Promise<ApprovalListResponse> {
    return this.requests.list(actorOf(user), query);
  }

  @Get('rules')
  @Roles('OWNER', 'MANAGER')
  async rules(@CurrentUser() user: JwtPayload): Promise<ApprovalRules> {
    return this.requests.rules(actorOf(user));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles('OWNER')
  async approve(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ApproveApprovalSchema)) body: ApproveApprovalDto,
  ): Promise<ApprovalView> {
    return this.approvals.approve(actorOf(user), id, body.totpCode);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles('OWNER')
  async reject(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(RejectApprovalSchema)) body: RejectApprovalDto,
  ): Promise<ApprovalView> {
    return this.requests.reject(actorOf(user), id, body.note);
  }
}
