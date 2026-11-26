import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import {
  SetYavinKeySchema,
  SetYavinUseSchema,
  StepUpWithReasonSchema,
  type SetYavinKeyDto,
  type SetYavinUseDto,
  type StepUpWithReasonDto,
  type YavinVenueStatus,
} from '@nightpay/contracts';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { YavinEnabledGuard } from '../gateways/yavin-flag';
import { SUPERADMIN_WRITE_LIMIT } from './rate-limits';
import { CurrentSuperAdmin, SuperAdminGuard, type SuperAdminActor } from './superadmin.guard';
import { SuperAdminYavinService } from './yavin-venue.service';

/** Yavin en un local (ver SuperAdminYavinService). Con YAVIN_ENABLED apagado, 404. */
@Controller('superadmin/venues/:id/yavin')
@UseGuards(YavinEnabledGuard, SuperAdminGuard)
export class SuperAdminYavinController {
  constructor(@Inject(SuperAdminYavinService) private readonly yavin: SuperAdminYavinService) {}

  @Get()
  async status(@Param('id', ParseUUIDPipe) id: string): Promise<YavinVenueStatus> {
    return this.yavin.status(id);
  }

  @Put('key')
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async setKey(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SetYavinKeySchema)) dto: SetYavinKeyDto,
  ): Promise<YavinVenueStatus> {
    return this.yavin.setKey(actor, id, dto);
  }

  @Post('use')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async setUse(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SetYavinUseSchema)) dto: SetYavinUseDto,
  ): Promise<YavinVenueStatus> {
    return this.yavin.setUse(actor, id, dto);
  }

  @Post('clear')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async clear(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<YavinVenueStatus> {
    return this.yavin.clear(actor, id, dto);
  }
}
