import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  AssignVenuesSchema,
  BusinessListQuerySchema,
  CreateBusinessSchema,
  PauseSchema,
  ResumeSchema,
  UpdateBusinessSchema,
  type AssignVenuesDto,
  type BusinessDetail,
  type BusinessListQuery,
  type BusinessView,
  type CreateBusinessDto,
  type PauseDto,
  type ResumeDto,
  type UpdateBusinessDto,
} from '@nightpay/contracts';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { SuperAdminBusinessesService } from './businesses.service';
import { SUPERADMIN_WRITE_LIMIT } from './rate-limits';
import { CurrentSuperAdmin, SuperAdminGuard, type SuperAdminActor } from './superadmin.guard';

/** Negocios clientes (razón social, contacto, pausa, locales). */
@Controller('superadmin/businesses')
@UseGuards(SuperAdminGuard)
export class SuperAdminBusinessesController {
  private readonly businesses: SuperAdminBusinessesService;

  constructor(@Inject(SuperAdminBusinessesService) businesses: SuperAdminBusinessesService) {
    this.businesses = businesses;
  }

  @Get()
  async list(@Query(new ZodValidationPipe(BusinessListQuerySchema)) query: BusinessListQuery): Promise<BusinessView[]> {
    return this.businesses.list(query);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<BusinessDetail> {
    return this.businesses.get(id);
  }

  @Post()
  @HttpCode(201)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async create(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Body(new ZodValidationPipe(CreateBusinessSchema)) dto: CreateBusinessDto,
  ): Promise<BusinessView> {
    return this.businesses.create(actor, dto);
  }

  @Patch(':id')
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async update(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateBusinessSchema)) dto: UpdateBusinessDto,
  ): Promise<BusinessView> {
    return this.businesses.update(actor, id, dto);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async pause(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PauseSchema)) dto: PauseDto,
  ): Promise<BusinessView> {
    return this.businesses.pause(actor, id, dto);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async resume(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ResumeSchema)) dto: ResumeDto,
  ): Promise<BusinessView> {
    return this.businesses.resume(actor, id, dto);
  }

  @Post(':id/venues')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async assignVenues(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(AssignVenuesSchema)) dto: AssignVenuesDto,
  ): Promise<BusinessDetail> {
    return this.businesses.assignVenues(actor, id, dto);
  }

  @Post(':id/venues/:venueId/unassign')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async unassignVenue(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ): Promise<BusinessDetail> {
    return this.businesses.unassignVenue(actor, id, venueId);
  }
}
