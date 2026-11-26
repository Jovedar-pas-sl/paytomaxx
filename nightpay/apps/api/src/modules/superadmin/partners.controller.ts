import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  CreatePartnerSchema,
  PartnerApiStateSchema,
  PartnerPauseSchema,
  PartnerResumeSchema,
  PartnerStepUpReasonSchema,
  UpdatePartnerSchema,
  type CreatePartnerDto,
  type PartnerApiStateDto,
  type PartnerPauseDto,
  type PartnerResumeDto,
  type PartnerStepUpReasonDto,
  type PartnerView,
  type SuperAdminPartnerConnectionView,
  type SuperAdminPartnersOverview,
  type UpdatePartnerDto,
} from '@nightpay/contracts';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { SuperAdminPartnersService } from './partners.service';
import { SUPERADMIN_WRITE_LIMIT } from './rate-limits';
import { CurrentSuperAdmin, SuperAdminGuard, type SuperAdminActor } from './superadmin.guard';

/** Socios de la API de socios (los cajeros y los que vengan), sus conexiones y la congelación. */
@Controller('superadmin/partners')
@UseGuards(SuperAdminGuard)
export class SuperAdminPartnersController {
  constructor(@Inject(SuperAdminPartnersService) private readonly partners: SuperAdminPartnersService) {}

  @Get()
  overview(): Promise<SuperAdminPartnersOverview> {
    return this.partners.overview();
  }

  @Post()
  @HttpCode(201)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  create(@CurrentSuperAdmin() actor: SuperAdminActor, @Body(new ZodValidationPipe(CreatePartnerSchema)) dto: CreatePartnerDto): Promise<PartnerView> {
    return this.partners.create(actor, dto);
  }

  @Put('api-state')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  setApiState(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Body(new ZodValidationPipe(PartnerApiStateSchema)) dto: PartnerApiStateDto,
  ): Promise<SuperAdminPartnersOverview['api']> {
    return this.partners.setApiState(actor, dto);
  }

  @Patch(':id')
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  update(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdatePartnerSchema)) dto: UpdatePartnerDto,
  ): Promise<PartnerView> {
    return this.partners.update(actor, id, dto);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  suspend(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PartnerStepUpReasonSchema)) dto: PartnerStepUpReasonDto,
  ): Promise<PartnerView> {
    return this.partners.suspend(actor, id, dto);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  resume(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PartnerResumeSchema)) dto: PartnerResumeDto,
  ): Promise<PartnerView> {
    return this.partners.resume(actor, id, dto);
  }

  @Post('connections/:id/pause')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  pauseConnection(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PartnerPauseSchema)) dto: PartnerPauseDto,
  ): Promise<SuperAdminPartnerConnectionView> {
    return this.partners.pauseConnection(actor, id, dto);
  }

  @Post('connections/:id/resume')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  resumeConnection(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PartnerResumeSchema)) dto: PartnerResumeDto,
  ): Promise<SuperAdminPartnerConnectionView> {
    return this.partners.resumeConnection(actor, id, dto);
  }

  @Post('connections/:id/revoke')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  revokeConnection(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PartnerStepUpReasonSchema)) dto: PartnerStepUpReasonDto,
  ): Promise<SuperAdminPartnerConnectionView> {
    return this.partners.revokeConnection(actor, id, dto);
  }
}
