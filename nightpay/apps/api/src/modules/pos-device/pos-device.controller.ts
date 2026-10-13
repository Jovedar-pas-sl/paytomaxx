import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { JwtPayload } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { CurrentDevice, DeviceGuard, type PosDevice } from './device.guard';
import { PaytefSaleResultSchema, PaytefShiftOperationSchema, type PaytefSaleResult } from './paytef';
import { PosDeviceService, type PendingPosCharge, type SaleOutcome, type ShiftSummary } from './pos-device.service';

const PairSchema = z.object({ code: z.string().trim().min(6).max(20) });
const VoidSchema = z.object({
  operationNumber: z.string().trim().min(1).max(64),
  approved: z.boolean(),
  resultText: z.string().max(200).optional(),
});
const ShiftSchema = z.object({ transactions: z.array(PaytefShiftOperationSchema).max(2000) });

/**
 * Datáfono PAX con la app NightPay.
 *  Panel (dueño):
 *   - POST   /v1/pos-device/terminals/:id/pairing-code → código para vincular un datáfono.
 *   - DELETE /v1/pos-device/terminals/:id/device       → desvincularlo.
 *  Datáfono (Authorization: Device <credencial>):
 *   - POST /v1/pos-device/pair                   → canjea el código por la credencial.
 *   - GET  /v1/pos-device/me | /pending          → quién soy y cobros por cobrar.
 *   - POST /v1/pos-device/charges/:id/start      → referencia e importe para el lector.
 *   - POST /v1/pos-device/charges/:id/result     → resultado de Paytef.
 *   - POST /v1/pos-device/charges/:id/void       → anulación hecha en el lector.
 *   - POST /v1/pos-device/shift                  → operaciones del cierre, para cuadrar.
 */
@Controller('pos-device')
export class PosDeviceController {
  private readonly pos: PosDeviceService;

  constructor(@Inject(PosDeviceService) pos: PosDeviceService) {
    this.pos = pos;
  }

  // ─── Panel del dueño ────────────────────────────────────────────────

  @Post('terminals/:id/pairing-code')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('OWNER')
  async pairingCode(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) terminalId: string,
  ): Promise<{ code: string; expiresAt: string }> {
    return this.pos.createPairingCode(user.tenantId, terminalId, user.sub);
  }

  @Delete('terminals/:id/device')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('OWNER')
  async unpair(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) terminalId: string): Promise<{ ok: true }> {
    await this.pos.unpair(user.tenantId, terminalId, user.sub);
    return { ok: true };
  }

  // ─── Datáfono ───────────────────────────────────────────────────────

  @Public()
  @Post('pair')
  @HttpCode(200)
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'pos-device-pair' })
  async pair(@Body(new ZodValidationPipe(PairSchema)) body: z.infer<typeof PairSchema>) {
    return this.pos.pair(body.code);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Get('me')
  async me(@CurrentDevice() device: PosDevice) {
    return this.pos.me(device);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Get('pending')
  async pending(@CurrentDevice() device: PosDevice): Promise<PendingPosCharge[]> {
    return this.pos.pending(device);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('charges/:id/start')
  @HttpCode(200)
  async start(@CurrentDevice() device: PosDevice, @Param('id', ParseUUIDPipe) id: string) {
    return this.pos.start(device, id);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('charges/:id/result')
  @HttpCode(200)
  async result(
    @CurrentDevice() device: PosDevice,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PaytefSaleResultSchema)) body: PaytefSaleResult,
  ): Promise<SaleOutcome> {
    return this.pos.reportResult(device, id, body);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('charges/:id/void')
  @HttpCode(200)
  async void(
    @CurrentDevice() device: PosDevice,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(VoidSchema)) body: z.infer<typeof VoidSchema>,
  ): Promise<{ ok: true }> {
    return this.pos.reportVoid(device, id, body);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('shift')
  @HttpCode(200)
  async shift(
    @CurrentDevice() device: PosDevice,
    @Body(new ZodValidationPipe(ShiftSchema)) body: z.infer<typeof ShiftSchema>,
  ): Promise<ShiftSummary> {
    return this.pos.reportShift(device, body.transactions);
  }
}
