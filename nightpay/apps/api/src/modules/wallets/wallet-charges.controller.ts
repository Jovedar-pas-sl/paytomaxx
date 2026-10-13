import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import { z } from 'zod';
import type { JwtPayload } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { WalletChargesService, type ChargeRequestView, type WalletLookup } from './wallet-charges.service';

const CreateRequestSchema = z
  .object({
    code: z.string().trim().min(6).max(10),
    serviceItemId: z.string().uuid().optional(),
    amountCents: z.number().int().positive().max(10_000_00).optional(),
    category: z.enum(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'EXTRA']).optional(),
  })
  .refine((b) => Boolean(b.serviceItemId) || Boolean(b.amountCents), {
    message: 'Elige un servicio de la carta o pon un importe',
  });

const PayoutSchema = z.object({
  method: z.enum(['CARD', 'CASH']),
  bankReference: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
});

/**
 * Saldo NightPay — personal del local.
 *  - GET  /v1/wallet-charges/lookup/:code       → saldo del cliente por su código.
 *  - POST /v1/wallet-charges                    → pedir un cobro (el cliente lo acepta en su móvil).
 *  - GET  /v1/wallet-charges/:id                → respuesta del cliente.
 *  - POST /v1/wallet-charges/:id/cancel         → retirar la petición.
 *  - POST /v1/wallet-charges/wallets/:id/payout → devolver el saldo (tarjeta o efectivo).
 *  - POST /v1/wallet-charges/wallets/:id/relink → enlace nuevo para el cliente (dueño).
 */
@Controller('wallet-charges')
@UseGuards(RolesGuard)
export class WalletChargesController {
  private readonly charges: WalletChargesService;
  private readonly config: ConfigService;

  constructor(
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.charges = charges;
    this.config = config;
  }

  // Contra probar códigos al azar: el personal de un local comparte IP, así
  // que el tope es holgado para el uso normal y corta un barrido.
  @Get('lookup/:code')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-lookup' })
  async lookup(@CurrentUser() user: JwtPayload, @Param('code') code: string): Promise<WalletLookup> {
    return this.charges.lookup(user.tenantId, code);
  }

  @Post()
  @HttpCode(201)
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-charge' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreateRequestSchema)) body: z.infer<typeof CreateRequestSchema>,
  ): Promise<ChargeRequestView> {
    return this.charges.createRequest({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body);
  }

  @Get(':id')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async get(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<ChargeRequestView> {
    return this.charges.getRequest({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async cancel(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.charges.cancelRequest({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id);
  }

  @Post('wallets/:id/payout')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  async payout(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(PayoutSchema)) body: z.infer<typeof PayoutSchema>,
  ) {
    return this.charges.payout({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId, body);
  }

  /** El QR lo escanea el cliente con su móvil; el enlace viejo deja de valer. */
  @Post('wallets/:id/relink')
  @HttpCode(200)
  @Roles('OWNER')
  async relink(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) walletId: string,
  ): Promise<{ url: string; qrDataUrl: string }> {
    const { path } = await this.charges.relink({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId);
    const base = (this.config.get<string>('NEXT_PUBLIC_API_URL') ?? '').replace(/\/+$/, '');
    const url = `${base}${path}`;
    const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
    return { url, qrDataUrl };
  }
}
