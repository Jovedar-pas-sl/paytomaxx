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
import {
  WalletChargesService,
  type ChargeRequestView,
  type PendingQrCharge,
  type QrChargeView,
  type WalletLookup,
} from './wallet-charges.service';

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

/** Cobro con QR: la chica elige el servicio (o un importe); el cliente paga con Face ID. */
const QrChargeSchema = z
  .object({
    serviceItemId: z.string().uuid().optional(),
    amountCents: z.number().int().positive().max(10_000_00).optional(),
    category: z.enum(['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'EXTRA']).optional(),
  })
  .refine((b) => Boolean(b.serviceItemId) || Boolean(b.amountCents), {
    message: 'Elige un servicio de la carta o pon un importe',
  });

const ApproveSchema = z.object({ walletId: z.string().uuid() });

/** El código del cliente y su PIN de 4 cifras (lo teclea él en el móvil de la chica). */
const PinSchema = z.object({
  code: z.string().trim().min(6).max(10),
  pin: z.string().regex(/^[0-9]{4}$/, 'El PIN son 4 cifras'),
});

const CardToken = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra');
const CardUid = z.string().trim().max(64).optional();

/** Pagar con PIN: el saldo por su código o por su ficha NFC. */
const PayPinSchema = z
  .object({
    code: z.string().trim().min(6).max(10).optional(),
    card: CardToken.optional(),
    uid: CardUid,
    pin: z.string().regex(/^[0-9]{4}$/, 'El PIN son 4 cifras'),
  })
  .refine((b) => Boolean(b.code) !== Boolean(b.card), { message: 'Falta el código o la ficha del cliente' });

const CardLookupSchema = z.object({ card: CardToken, uid: CardUid });

const LinkCardSchema = z.object({
  code: z.string().trim().min(6).max(10),
  card: CardToken,
  uid: CardUid,
});

const PayoutSchema = z.object({
  method: z.enum(['CARD', 'CASH']),
  bankReference: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
});

/**
 * Saldo NightPay — personal del local.
 *  - GET  /v1/wallet-charges/lookup/:code       → saldo del cliente por su código.
 *  - POST /v1/wallet-charges/qr                 → cobro con QR: el cliente lo paga con Face ID.
 *  - GET  /v1/wallet-charges/pending-qr         → (encargado) cobros con QR sin pagar.
 *  - POST /v1/wallet-charges/:id/approve        → (encargado) cobrarlo de un saldo sin Face ID.
 *  - POST /v1/wallet-charges/:id/pin            → el cliente lo paga con su PIN (sin sacar el móvil).
 *  - POST /v1/wallet-charges/pin                → el cliente elige su PIN (tras recargar, o con el encargado).
 *  - POST /v1/wallet-charges/wallets/:id/pin/unlock|reset → (encargado) desbloquear o borrar el PIN.
 *  - POST /v1/wallet-charges/cards/lookup       → el saldo de la ficha NFC que acercan.
 *  - POST /v1/wallet-charges/cards/new          → código nuevo para grabar en una ficha vacía.
 *  - POST /v1/wallet-charges/cards              → dar ficha al saldo (al recargar, o el encargado).
 *  - POST /v1/wallet-charges/wallets/:id/card/block → (encargado) ficha perdida.
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

  /**
   * La chica elige el servicio y enseña el QR; el cliente lo escanea y paga
   * desbloqueando su móvil (Face ID, huella o el PIN del teléfono).
   */
  @Post('qr')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @HttpCode(201)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-charge' })
  async createQrCharge(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(QrChargeSchema)) body: z.infer<typeof QrChargeSchema>,
  ): Promise<QrChargeView & { payUrl: string; qrPngDataUrl: string }> {
    const charge = await this.charges.createQrCharge(
      { userId: user.sub, role: user.role, tenantId: user.tenantId },
      body,
    );
    const base = (this.config.get<string>('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4100').replace(/\/+$/, '');
    const payUrl = `${base}/s/${charge.payToken}`;
    const qrPngDataUrl = await QRCode.toDataURL(payUrl, { width: 480, margin: 1, errorCorrectionLevel: 'M' });
    return { ...charge, payUrl, qrPngDataUrl };
  }

  /** Encargado o dueño: cobros con QR que nadie ha pagado (cliente sin batería…). */
  @Get('pending-qr')
  @Roles('OWNER', 'MANAGER')
  async pendingQr(@CurrentUser() user: JwtPayload): Promise<PendingQrCharge[]> {
    return this.charges.pendingQrCharges({ userId: user.sub, role: user.role, tenantId: user.tenantId });
  }

  /** Encargado o dueño: cobrar un cobro con QR de un saldo, sin Face ID (queda en la auditoría). */
  @Post(':id/approve')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-approve' })
  async approve(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ApproveSchema)) body: z.infer<typeof ApproveSchema>,
  ): Promise<ChargeRequestView> {
    return this.charges.approveWithoutFaceId({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id, body.walletId);
  }

  /** El cliente no saca el móvil: teclea su PIN en el de la chica y paga este mismo cobro. */
  @Post(':id/pin')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-pin' })
  async payWithPin(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PayPinSchema)) body: z.infer<typeof PayPinSchema>,
  ): Promise<ChargeRequestView> {
    const ref = body.card ? { card: body.card, uid: body.uid ?? null } : { code: body.code ?? '' };
    return this.charges.payQrChargeWithPin({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id, {
      ...ref,
      pin: body.pin,
    });
  }

  /** La chica acerca la ficha NFC del cliente: su saldo (y si tiene PIN). En el cuerpo, no en la URL (registros). */
  @Post('cards/lookup')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @HttpCode(200)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-lookup' })
  async lookupCard(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CardLookupSchema)) body: z.infer<typeof CardLookupSchema>,
  ): Promise<WalletLookup> {
    return this.charges.lookupCard(user.tenantId, { card: body.card, uid: body.uid ?? null });
  }

  /** Código nuevo (del servidor) para grabar en una ficha vacía. */
  @Post('cards/new')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @HttpCode(201)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-card' })
  async issueCard(@CurrentUser() user: JwtPayload): Promise<{ card: string }> {
    return this.charges.issueCard({ userId: user.sub, role: user.role, tenantId: user.tenantId });
  }

  /** Dar ficha NFC al saldo recién recargado (o el encargado, a cualquiera). */
  @Post('cards')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-card' })
  async linkCard(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(LinkCardSchema)) body: z.infer<typeof LinkCardSchema>,
  ): Promise<WalletLookup> {
    return this.charges.linkCard({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body);
  }

  @Post('wallets/:id/card/block')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(200)
  async blockCard(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.charges.blockCard({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id);
  }

  /** El cliente elige su PIN en el móvil de la chica (en los 15 min tras recargar, o con el encargado). */
  @Post('pin')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-pin-set' })
  async setPin(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(PinSchema)) body: z.infer<typeof PinSchema>,
  ): Promise<WalletLookup> {
    return this.charges.setPin({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body);
  }

  @Post('wallets/:id/pin/unlock')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(200)
  async unlockPin(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.charges.unlockPin({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id);
  }

  @Post('wallets/:id/pin/reset')
  @Roles('OWNER', 'MANAGER')
  @HttpCode(200)
  async resetPin(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.charges.resetPin({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id);
  }

  // Contra probar códigos al azar: el personal de un local comparte IP, así
  // que el tope es holgado para el uso normal y corta un barrido.
  /** La recarga recién cobrada: su código y si ya tiene PIN (para que lo elija aquí). */
  @Get('wallets/:id/lookup')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-lookup' })
  async lookupById(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<WalletLookup> {
    return this.charges.lookupById({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id);
  }

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
