import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import {
  WalletChargesService,
  type ChargeRequestView,
  type PendingQrCharge,
  type TerminalWalletCheck,
  type TerminalWalletRef,
} from '../wallets/wallet-charges.service';
import { CurrentDevice, DeviceGuard, type PosDevice } from './device.guard';

/** Los enlaces del cobro (/s/…), del pase (/w/…) y de la ficha: 16–64 caracteres base64url. */
const LinkToken = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Este QR no es nuestro');

const ScanSchema = z.object({ payToken: LinkToken });

/**
 * De qué saldo es: su ficha NFC (con su número de serie, que el datáfono
 * siempre lee), el QR de su pase de Google Wallet o su código. Uno solo.
 */
const RefFields = z.object({
  code: z.string().trim().min(6).max(10).optional(),
  card: LinkToken.optional(),
  uid: z.string().trim().max(64).optional(),
  walletToken: LinkToken.optional(),
});
type RefBody = z.infer<typeof RefFields>;

const ONE_REF = {
  check: (b: RefBody) => [b.code, b.card, b.walletToken].filter(Boolean).length === 1,
  message: 'Falta la ficha, el pase o el código del cliente',
};

export const RefSchema = RefFields.refine(ONE_REF.check, { message: ONE_REF.message });
export const PinSchema = RefFields.extend({ pin: z.string().regex(/^[0-9]{4}$/, 'El PIN son 4 cifras') }).refine(
  ONE_REF.check,
  { message: ONE_REF.message },
);

/** Pagar con el NFC solo: en el datáfono siempre con su número de serie (lo lee su lector). */
export const NfcSchema = z.object({ card: LinkToken, uid: z.string().trim().min(1).max(64) });

export function refOf(body: RefBody): TerminalWalletRef {
  if (body.card) return { card: body.card, uid: body.uid ?? null };
  if (body.walletToken) return { walletToken: body.walletToken };
  return { code: body.code ?? '' };
}

/**
 * Cobrar del saldo en el datáfono (Authorization: Device <credencial>): el
 * cliente paga con su PIN, tecleado en el datáfono, un cobro con QR que hizo
 * una chica. Solo cobros de este local y saldos de su grupo.
 *   - GET  /v1/pos-device/saldo/charges          → cobros con QR sin pagar.
 *   - POST /v1/pos-device/saldo/charges/scan     → el cobro del QR escaneado (/s/<payToken>).
 *   - GET  /v1/pos-device/saldo/charges/:id      → ¿se pagó? (tras un corte, antes de repetir).
 *   - POST /v1/pos-device/saldo/charges/:id/check → ¿le llega? (sin enseñar su saldo).
 *   - POST /v1/pos-device/saldo/charges/:id/pin  → pagarlo con su PIN.
 *   - POST /v1/pos-device/saldo/charges/:id/nfc  → pagarlo con su NFC solo (hasta el tope sin PIN; si no, 409 PIN_REQUIRED).
 * Topes por IP más estrictos que los de la app del personal: un datáfono
 * robado o en manos ajenas no sirve para probar códigos ni PIN.
 */
@Controller('pos-device/saldo')
export class PosDeviceSaldoController {
  private readonly charges: WalletChargesService;

  constructor(@Inject(WalletChargesService) charges: WalletChargesService) {
    this.charges = charges;
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Get('charges')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pos-saldo-list' })
  async list(@CurrentDevice() device: PosDevice): Promise<PendingQrCharge[]> {
    return this.charges.pendingQrChargesForTerminal(device);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('charges/scan')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'pos-saldo-scan' })
  async scan(
    @CurrentDevice() device: PosDevice,
    @Body(new ZodValidationPipe(ScanSchema)) body: z.infer<typeof ScanSchema>,
  ): Promise<PendingQrCharge> {
    return this.charges.qrChargeForTerminal(device, body.payToken);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Get('charges/:id')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pos-saldo-list' })
  async status(
    @CurrentDevice() device: PosDevice,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChargeRequestView> {
    return this.charges.qrChargeStatusForTerminal(device, id);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('charges/:id/check')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'pos-saldo-check' })
  async check(
    @CurrentDevice() device: PosDevice,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(RefSchema)) body: RefBody,
  ): Promise<TerminalWalletCheck> {
    return this.charges.checkWalletForTerminal(device, id, refOf(body));
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('charges/:id/pin')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pos-saldo-pin' })
  async pin(
    @CurrentDevice() device: PosDevice,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PinSchema)) body: z.infer<typeof PinSchema>,
  ): Promise<ChargeRequestView> {
    return this.charges.payQrChargeFromTerminal(device, id, { ...refOf(body), pin: body.pin });
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('charges/:id/nfc')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pos-saldo-pin' })
  async nfc(
    @CurrentDevice() device: PosDevice,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(NfcSchema)) body: z.infer<typeof NfcSchema>,
  ): Promise<ChargeRequestView> {
    return this.charges.payQrChargeFromTerminalWithCard(device, id, { card: body.card, uid: body.uid });
  }
}
