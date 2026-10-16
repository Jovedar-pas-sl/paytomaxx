import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
  CreateStaffUserSchema,
  ReasonOnlySchema,
  SetSuperAdminSchema,
  StaffListQuerySchema,
  StepUpWithReasonSchema,
  type CreateStaffUserDto,
  type CreateStaffUserResponse,
  type ReasonOnlyDto,
  type ResetStaffPasswordResponse,
  type RevokeSessionsResponse,
  type SetSuperAdminDto,
  type StaffListQuery,
  type StaffUserPage,
  type StaffUserView,
  type StepUpWithReasonDto,
} from '@nightpay/contracts';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { SUPERADMIN_WRITE_LIMIT } from './rate-limits';
import { SuperAdminStaffService } from './staff.service';
import { CurrentSuperAdmin, SuperAdminGuard, type SuperAdminActor } from './superadmin.guard';

/** Personal y administradores de todos los locales. */
@Controller('superadmin/users')
@UseGuards(SuperAdminGuard)
export class SuperAdminStaffController {
  private readonly staff: SuperAdminStaffService;

  constructor(@Inject(SuperAdminStaffService) staff: SuperAdminStaffService) {
    this.staff = staff;
  }

  @Get()
  async list(@Query(new ZodValidationPipe(StaffListQuerySchema)) query: StaffListQuery): Promise<StaffUserPage> {
    return this.staff.list(query);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<StaffUserView> {
    return this.staff.get(id);
  }

  @Post()
  @HttpCode(201)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async create(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Body(new ZodValidationPipe(CreateStaffUserSchema)) dto: CreateStaffUserDto,
  ): Promise<CreateStaffUserResponse> {
    return this.staff.create(actor, dto);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async resetPassword(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<ResetStaffPasswordResponse> {
    return this.staff.resetPassword(actor, id, dto);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async disable(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<StaffUserView> {
    return this.staff.disable(actor, id, dto);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async enable(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<StaffUserView> {
    return this.staff.enable(actor, id, dto);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async revokeSessions(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ReasonOnlySchema)) dto: ReasonOnlyDto,
  ): Promise<RevokeSessionsResponse> {
    return this.staff.revokeSessions(actor, id, dto);
  }

  @Post(':id/totp/reset')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async resetTotp(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<StaffUserView> {
    return this.staff.resetTotp(actor, id, dto);
  }

  @Post(':id/super-admin')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async setSuperAdmin(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SetSuperAdminSchema)) dto: SetSuperAdminDto,
  ): Promise<StaffUserView> {
    return this.staff.setSuperAdmin(actor, id, dto);
  }
}
