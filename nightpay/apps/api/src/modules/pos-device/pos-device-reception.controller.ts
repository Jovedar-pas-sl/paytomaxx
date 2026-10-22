import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  CashTopUpSchema,
  DeviceCardTopUpSchema,
  type CashTopUpDto,
  type CashTopUpResult,
  type DeviceCardTopUpDto,
  type ReceptionOptions,
  type StockOutcome,
} from '@nightpay/contracts';
import { z } from 'zod';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { WalletCardsService } from '../wallets/wallet-cards.service';
import {
  WalletChargesService,
  type ReceptionCardView,
  type ReceptionWalletView,
} from '../wallets/wallet-charges.service';
import { DeviceRateLimit, DeviceRateLimitGuard } from './device-rate-limit.guard';
import { CurrentDevice, DeviceGuard, type PosDevice } from './device.guard';
import {
  PosDeviceReceptionService,
  type ReceptionCardSale,
  type ReceptionTopUpView,
} from './pos-device-reception.service';

const CardToken = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra');
const CardSchema = z.object({ card: CardToken, uid: z.string().trim().max(64).optional() });
const PinSchema = z.object({ pin: z.string().regex(/^[0-9]{4}$/, 'El PIN son 4 cifras') });
const NumberSchema = z.object({
  card: CardToken,
  uid: z.string().min(8).max(64),
  printedNumber: z.string().regex(/^[0-9]{1,12}$/, 'Escribe entre 1 y 12 cifras del número impreso'),
}).strict();
/** Recargas por datáfono y minuto (tarjeta y efectivo juntas), venga de la IP que venga. */
const TOP_UP_PER_TERMINAL = { max: 10, windowSec: 60, scope: 'pos-reception-topup' };

/**
 * Recepción en el datáfono (Authorization: Device <credencial>): recargar el
 * saldo con tarjeta (venta de Paytef en este datáfono) o en efectivo, darle la
 * ficha, que el cliente elija su PIN y «Preparar fichas». Todo del local del
 * datáfono, con topes por IP y en la auditoría con su terminalId.
 *   - GET  /v1/pos-device/reception/options           → qué se puede (tarjeta, efectivo, fichas).
 *   - POST /v1/pos-device/reception/cash              → recarga en efectivo (sumada al momento).
 *   - POST /v1/pos-device/reception/card              → recarga con tarjeta: referencia para el lector.
 *   - GET  /v1/pos-device/reception/topups/:paymentId → cómo quedó una recarga con tarjeta de este
 *                                                        datáfono (sumada, pendiente de Paytef, sin cobrar),
 *                                                        también la de una ficha que ya tenía saldo.
 *   - POST /v1/pos-device/reception/lookup            → la ficha acercada: de qué saldo es (sin enseñarlo).
 *   - GET  /v1/pos-device/reception/wallets/:id       → el saldo recién recargado aquí (código, PIN, ficha).
 *   - POST /v1/pos-device/reception/wallets/:id/card  → darle la ficha acercada.
 *   - POST /v1/pos-device/reception/wallets/:id/pin   → el cliente elige su PIN.
 *   - POST /v1/pos-device/reception/fichas/token      → código nuevo para grabar en una ficha vacía.
 *   - POST /v1/pos-device/reception/fichas/stock      → la ficha acercada, al stock del local.
 *   - POST /v1/pos-device/reception/fichas/number     → su número impreso (con la ficha delante).
 * La venta con tarjeta se confirma con POST /v1/pos-device/charges/:id/result (la de siempre).
 * Recargar (tarjeta y efectivo) tiene además tope por datáfono: 10 por minuto
 * (sin importar la IP) y los de 24 h de reception-limits.
 */
@Controller('pos-device/reception')
export class PosDeviceReceptionController {
  private readonly reception: PosDeviceReceptionService;
  private readonly charges: WalletChargesService;
  private readonly cards: WalletCardsService;

  constructor(
    @Inject(PosDeviceReceptionService) reception: PosDeviceReceptionService,
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(WalletCardsService) cards: WalletCardsService,
  ) {
    this.reception = reception;
    this.charges = charges;
    this.cards = cards;
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Get('options')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pos-reception-read' })
  async options(@CurrentDevice() device: PosDevice): Promise<ReceptionOptions> {
    return this.reception.options(device);
  }

  @Public()
  @UseGuards(DeviceGuard, DeviceRateLimitGuard)
  @Post('cash')
  @HttpCode(201)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pos-reception-topup' })
  @DeviceRateLimit(TOP_UP_PER_TERMINAL)
  async cash(
    @CurrentDevice() device: PosDevice,
    @Body(new ZodValidationPipe(CashTopUpSchema)) body: CashTopUpDto,
  ): Promise<CashTopUpResult> {
    return this.reception.cashTopUp(device, body);
  }

  @Public()
  @UseGuards(DeviceGuard, DeviceRateLimitGuard)
  @Post('card')
  @HttpCode(201)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pos-reception-topup' })
  @DeviceRateLimit(TOP_UP_PER_TERMINAL)
  async card(
    @CurrentDevice() device: PosDevice,
    @Body(new ZodValidationPipe(DeviceCardTopUpSchema)) body: DeviceCardTopUpDto,
  ): Promise<ReceptionCardSale> {
    return this.reception.cardTopUp(device, body);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Get('topups/:paymentId')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pos-reception-read' })
  async topUp(
    @CurrentDevice() device: PosDevice,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<ReceptionTopUpView> {
    return this.reception.topUpResult(device, paymentId);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('lookup')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'pos-reception-lookup' })
  async lookup(
    @CurrentDevice() device: PosDevice,
    @Body(new ZodValidationPipe(CardSchema)) body: z.infer<typeof CardSchema>,
  ): Promise<ReceptionCardView> {
    return this.charges.lookupCardForReception(device.tenantId, { card: body.card, uid: body.uid ?? null });
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Get('wallets/:id')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pos-reception-read' })
  async wallet(@CurrentDevice() device: PosDevice, @Param('id', ParseUUIDPipe) id: string): Promise<ReceptionWalletView> {
    return this.charges.receptionWallet(device, id);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('wallets/:id/card')
  @HttpCode(200)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'pos-reception-card' })
  async linkCard(
    @CurrentDevice() device: PosDevice,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(CardSchema)) body: z.infer<typeof CardSchema>,
  ): Promise<ReceptionWalletView> {
    return this.charges.linkCardFromTerminal(device, { walletId: id, card: body.card, uid: body.uid ?? null });
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('wallets/:id/pin')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'pos-reception-pin' })
  async pin(
    @CurrentDevice() device: PosDevice,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PinSchema)) body: z.infer<typeof PinSchema>,
  ): Promise<ReceptionWalletView> {
    return this.charges.setPinFromTerminal(device, id, body.pin);
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('fichas/token')
  @HttpCode(201)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pos-reception-fichas' })
  async fichaToken(@CurrentDevice() device: PosDevice): Promise<{ card: string }> {
    return this.cards.newStockToken(device.tenantId, { userId: null, terminalId: device.terminalId });
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('fichas/stock')
  @HttpCode(200)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pos-reception-fichas' })
  async fichaStock(
    @CurrentDevice() device: PosDevice,
    @Body(new ZodValidationPipe(CardSchema)) body: z.infer<typeof CardSchema>,
  ): Promise<StockOutcome> {
    return this.cards.stock(device.tenantId, { userId: null, terminalId: device.terminalId }, { card: body.card, uid: body.uid ?? null });
  }

  @Public()
  @UseGuards(DeviceGuard)
  @Post('fichas/number')
  @HttpCode(200)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'pos-reception-fichas' })
  async fichaNumber(
    @CurrentDevice() device: PosDevice,
    @Body(new ZodValidationPipe(NumberSchema)) body: z.infer<typeof NumberSchema>,
  ): Promise<{ printedNumber: string }> {
    return this.cards.labelStockFromDevice(device.tenantId, device.terminalId, body);
  }
}
