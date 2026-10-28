import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  GenerateSettlementSchema,
  RecordSettlementPaymentSchema,
  SetOxioPayPayeeSchema,
  SetSettlementStartSchema,
  SettlementListQuerySchema,
  VoidSettlementSchema,
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
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { sendSettlementCsv, sendSettlementDocument } from '../oxiopay-settlements/settlement-responses';
import { SUPERADMIN_WRITE_LIMIT } from './rate-limits';
import { SuperAdminSettlementsService } from './settlements.service';
import { CurrentSuperAdmin, SuperAdminGuard, type SuperAdminActor } from './superadmin.guard';

/** «Liquidaciones OxioPay» de todos los locales (docs/SUPERADMIN.md). */
@Controller('superadmin/oxiopay-settlements')
@UseGuards(SuperAdminGuard)
export class SuperAdminSettlementsController {
  private readonly settlements: SuperAdminSettlementsService;

  constructor(@Inject(SuperAdminSettlementsService) settlements: SuperAdminSettlementsService) {
    this.settlements = settlements;
  }

  @Get()
  async list(@Query(new ZodValidationPipe(SettlementListQuerySchema)) query: SettlementListQuery): Promise<SuperAdminSettlementPage> {
    return this.settlements.list(query);
  }

  @Get('payee')
  async payee(): Promise<{ payee: OxioPayPayee | null }> {
    return { payee: await this.settlements.payee() };
  }

  @Put('payee')
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async setPayee(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Body(new ZodValidationPipe(SetOxioPayPayeeSchema)) dto: SetOxioPayPayeeDto,
  ): Promise<{ payee: OxioPayPayee }> {
    return { payee: await this.settlements.setPayee(actor, dto) };
  }

  @Get('settings')
  async settings(): Promise<{ startWeek: string | null }> {
    return this.settlements.settings();
  }

  @Put('settings')
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async setSettings(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Body(new ZodValidationPipe(SetSettlementStartSchema)) dto: SetSettlementStartDto,
  ): Promise<{ startWeek: string }> {
    return this.settlements.setStartWeek(actor, dto);
  }

  @Post('generate')
  @HttpCode(201)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async generate(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Body(new ZodValidationPipe(GenerateSettlementSchema)) dto: GenerateSettlementDto,
  ): Promise<SettlementDetail> {
    return this.settlements.generate(actor, dto);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<SettlementDetail> {
    return this.settlements.get(id);
  }

  @Get(':id/document')
  async document(@Param('id', ParseUUIDPipe) id: string, @Res() res: FastifyReply): Promise<void> {
    sendSettlementDocument(res, await this.settlements.get(id));
  }

  @Get(':id/csv')
  async csv(@Param('id', ParseUUIDPipe) id: string, @Res() res: FastifyReply): Promise<void> {
    sendSettlementCsv(res, await this.settlements.get(id));
  }

  @Post(':id/payments')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async recordPayment(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(RecordSettlementPaymentSchema)) dto: RecordSettlementPaymentDto,
  ): Promise<SettlementDetail> {
    return this.settlements.recordPayment(actor, id, dto);
  }

  @Post(':id/void')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async void(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(VoidSettlementSchema)) dto: VoidSettlementDto,
  ): Promise<SettlementDetail> {
    return this.settlements.void(actor, id, dto);
  }
}
