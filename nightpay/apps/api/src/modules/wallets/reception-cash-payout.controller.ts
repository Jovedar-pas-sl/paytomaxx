import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type {
  JwtPayload,
  ReceptionPayoutPasskeyRequest,
  ReceptionPayoutPasskeyStatus,
  ReceptionPayoutPlan,
} from '@nightpay/contracts';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { clientIp, type ClientIpRequest } from '../../common/http/client-ip';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import type { ReceptionCashResult, ReceptionDevice } from './reception-cash-payout';
import { ReceptionPayoutService } from './reception-payout.service';

const RequestKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);

const CardProof = {
  card: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  uid: z.string().min(8).max(64),
  expectedAmountCents: z.number().int().positive().max(99_999),
  requestKey: RequestKeySchema,
};

/** La salida: el NFC original, el importe confirmado y el PIN del cliente (o su Face ID ya confirmado en su móvil). */
export const ReceptionCashSchema = z.object({
  ...CardProof,
  pin: z.string().regex(/^\d{4}$/).optional(),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
}).strict();

/** El QR para que confirme con su Face ID: el mismo NFC original e importe, sin PIN. */
export const ReceptionPasskeySchema = z.object(CardProof).strict();

export type DeviceRequest = ClientIpRequest & { headers?: Record<string, string | string[] | undefined> };

/** El móvil de recepción (IP de fiar y navegador) para el registro de la salida. */
export function deviceOf(req: DeviceRequest | undefined): ReceptionDevice {
  if (!req) return {};
  const ua = req.headers?.['user-agent'];
  const userAgent = Array.isArray(ua) ? ua[0] : ua;
  return { ip: clientIp(req) ?? undefined, userAgent: userAgent ? userAgent.slice(0, 300) : undefined };
}

/**
 * Salida de recepción con el NFC del cliente (maqueta 4.5):
 *  - POST /v1/reception/wallets/:id/payout/plan          → qué hace falta (antes del PIN).
 *  - POST /v1/reception/wallets/:id/payout/passkey       → QR para que confirme con su Face ID.
 *  - GET  /v1/reception/wallets/:id/payout/passkey/:key  → si ya lo confirmó.
 *  - POST /v1/reception/wallets/:id/payout               → devolver (o dejarlo al encargado).
 */
@Controller('reception')
@UseGuards(RolesGuard)
export class ReceptionCashPayoutController {
  constructor(@Inject(ReceptionPayoutService) private readonly payouts: ReceptionPayoutService) {}

  @Post('wallets/:id/payout')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'reception-payout' })
  payout(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(ReceptionCashSchema)) body: z.infer<typeof ReceptionCashSchema>,
    @Req() req?: DeviceRequest,
  ): Promise<ReceptionCashResult> {
    return this.payouts.payout({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId, body, deviceOf(req));
  }

  @Post('wallets/:id/payout/plan')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-payout-plan' })
  plan(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) walletId: string): Promise<ReceptionPayoutPlan> {
    return this.payouts.plan({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId);
  }

  @Post('wallets/:id/payout/passkey')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'reception-payout-passkey' })
  passkey(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(ReceptionPasskeySchema)) body: z.infer<typeof ReceptionPasskeySchema>,
  ): Promise<ReceptionPayoutPasskeyRequest> {
    return this.payouts.requestPasskey({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId, body);
  }

  @Get('wallets/:id/payout/passkey/:requestKey')
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'reception-payout-passkey-status' })
  passkeyStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) walletId: string,
    @Param('requestKey', new ZodValidationPipe(RequestKeySchema)) requestKey: string,
  ): Promise<ReceptionPayoutPasskeyStatus> {
    return this.payouts.passkeyStatus({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId, requestKey);
  }
}
