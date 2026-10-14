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

/** El saldo, por su código o por la pulsera NFC (uno de los dos). */
const WalletRef = {
  code: z.string().trim().min(6).max(10).optional(),
  tag: z.string().trim().min(8).max(64).optional(),
};
const PinField = z.string().regex(/^[0-9]{4}$/, 'El PIN son 4 cifras');

const PinChargeSchema = z
  .object({
    ...WalletRef,
    serviceItemId: z.string().uuid().optional(),
    amountCents: z.number().int().positive().max(10_000_00).optional(),
    category: z.enum(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'EXTRA']).optional(),
    pin: PinField,
  })
  .refine((b) => Boolean(b.code) || Boolean(b.tag), { message: 'Falta el código o la pulsera del cliente' })
  .refine((b) => Boolean(b.serviceItemId) || Boolean(b.amountCents), {
    message: 'Elige un servicio de la carta o pon un importe',
  });

const SetPinSchema = z
  .object({ ...WalletRef, pin: PinField })
  .refine((b) => Boolean(b.code) || Boolean(b.tag), { message: 'Falta el código o la pulsera del cliente' });

const AssignTagSchema = z.object({
  code: z.string().trim().min(6).max(10),
  tag: z.string().trim().min(8).max(64),
});

function actorOf(user: JwtPayload) {
  return { userId: user.sub, role: user.role, tenantId: user.tenantId };
}

const PayoutSchema = z.object({
  method: z.enum(['CARD', 'CASH']),
  bankReference: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
});

/**
 * Saldo NightPay — personal del local.
 *  - GET  /v1/wallet-charges/lookup/:code       → saldo del cliente por su código.
 *  - GET  /v1/wallet-charges/lookup-tag/:tag   → saldo del cliente por su pulsera NFC.
 *  - POST /v1/wallet-charges/pin-charge         → cobrar con el PIN del cliente (al momento).
 *  - POST /v1/wallet-charges/pin | /tag         → el cliente elige su PIN · pulsera NFC.
 *  - POST /v1/wallet-charges/wallets/:id/unlock-pin | reset-pin → encargado o dueño.
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

  /** La pulsera o tarjeta NFC del cliente (Android). */
  @Get('lookup-tag/:tag')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-lookup' })
  async lookupTag(@CurrentUser() user: JwtPayload, @Param('tag') tag: string): Promise<WalletLookup> {
    return this.charges.lookupByTag(user.tenantId, tag);
  }

  /** El saldo de una recarga recién cobrada (para el PIN y la pulsera). */
  @Get('wallets/:id')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async walletById(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<WalletLookup> {
    return this.charges.lookupById(user.tenantId, id);
  }

  /**
   * Cobrar del saldo con el PIN del cliente: se cobra al momento. 5 PIN
   * fallidos bloquean el saldo (por cliente, no por IP).
   */
  @Post('pin-charge')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @HttpCode(201)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-charge' })
  async chargeWithPin(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(PinChargeSchema)) body: z.infer<typeof PinChargeSchema>,
  ): Promise<ChargeRequestView> {
    return this.charges.chargeWithPin(actorOf(user), body);
  }

  /** El cliente elige su PIN en el móvil de la chica (si aún no tiene). */
  @Post('pin')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-pin' })
  async setPin(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(SetPinSchema)) body: z.infer<typeof SetPinSchema>,
  ): Promise<WalletLookup> {
    return this.charges.setPin(actorOf(user), body);
  }

  /** Pulsera o tarjeta NFC para este saldo. */
  @Post('tag')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @HttpCode(200)
  async assignTag(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(AssignTagSchema)) body: z.infer<typeof AssignTagSchema>,
  ): Promise<WalletLookup> {
    return this.charges.assignTag(actorOf(user), body);
  }

  /** Encargado o dueño: tras 5 PIN fallidos, desbloquear. */
  @Post('wallets/:id/unlock-pin')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(200)
  async unlockPin(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.charges.unlockPin(actorOf(user), id);
  }

  /** Encargado o dueño: el cliente olvidó su PIN → lo borra y elige otro. */
  @Post('wallets/:id/reset-pin')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(200)
  async resetPin(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.charges.resetPin(actorOf(user), id);
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
