import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  CreateVenueSchema,
  PauseSchema,
  ResumeSchema,
  SetSettlementAccountSchema,
  StepUpWithReasonSchema,
  UpdateVenueProfileSchema,
  UpdateVenueRulesSchema,
  VenueListQuerySchema,
  type CreateVenueDto,
  type PauseDto,
  type ResumeDto,
  type SetSettlementAccountDto,
  type StepUpWithReasonDto,
  type UpdateVenueProfileDto,
  type UpdateVenueRulesDto,
  type VenueDetail,
  type VenueListItem,
  type VenueListQuery,
} from '@nightpay/contracts';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { SUPERADMIN_WRITE_LIMIT } from './rate-limits';
import { CurrentSuperAdmin, SuperAdminGuard, type SuperAdminActor } from './superadmin.guard';
import { SuperAdminVenuesService } from './venues.service';

/**
 * Todos los locales. GET/POST /v1/admin/venues (el desplegable de locales del
 * panel) siguen como estaban; esto es lo de la consola.
 */
@Controller('superadmin/venues')
@UseGuards(SuperAdminGuard)
export class SuperAdminVenuesController {
  private readonly venues: SuperAdminVenuesService;

  constructor(@Inject(SuperAdminVenuesService) venues: SuperAdminVenuesService) {
    this.venues = venues;
  }

  @Get()
  async list(@Query(new ZodValidationPipe(VenueListQuerySchema)) query: VenueListQuery): Promise<VenueListItem[]> {
    return this.venues.list(query);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<VenueDetail> {
    return this.venues.get(id);
  }

  @Post()
  @HttpCode(201)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async create(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Body(new ZodValidationPipe(CreateVenueSchema)) dto: CreateVenueDto,
  ): Promise<VenueDetail> {
    return this.venues.create(actor, dto);
  }

  @Patch(':id/profile')
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async updateProfile(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateVenueProfileSchema)) dto: UpdateVenueProfileDto,
  ): Promise<VenueDetail> {
    return this.venues.updateProfile(actor, id, dto);
  }

  @Patch(':id/rules')
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async updateRules(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateVenueRulesSchema)) dto: UpdateVenueRulesDto,
  ): Promise<VenueDetail> {
    return this.venues.updateRules(actor, id, dto);
  }

  @Put(':id/settlement-account')
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async setSettlementAccount(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SetSettlementAccountSchema)) dto: SetSettlementAccountDto,
  ): Promise<VenueDetail> {
    return this.venues.setSettlementAccount(actor, id, dto);
  }

  @Post(':id/settlement-account/clear')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async clearSettlementAccount(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<VenueDetail> {
    return this.venues.clearSettlementAccount(actor, id, dto);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async pause(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PauseSchema)) dto: PauseDto,
  ): Promise<VenueDetail> {
    return this.venues.pause(actor, id, dto);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async resume(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ResumeSchema)) dto: ResumeDto,
  ): Promise<VenueDetail> {
    return this.venues.resume(actor, id, dto);
  }
}
