import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  CashTopUpSchema,
  CashTopUpVoidSchema,
  SaldoRefSchema,
  paymentMethodsOf,
  type CashTopUpDto,
  type CashTopUpResult,
  type CashTopUpVoidDto,
  type CashTopUpVoidResult,
  type JwtPayload,
  type ReceptionDeskView,
  type ReceptionOptions,
  type SaldoRefDto,
  type StockOutcome,
} from '@nightpay/contracts';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { VENUE_SERVICE_FEE_SELECT, venueServiceFeeOf } from '../payments/service-fee';
import { venuePauseScope, VENUE_PAUSE_SELECT } from '../venues/venue-pause';
import { CashTopUpService, type RecentCashTopUp } from './wallet-cash-topup.service';
import { WalletCardsService } from './wallet-cards.service';
import { WalletChargesService, type ReceptionCardView } from './wallet-charges.service';

const CardSchema = z.object({
  card: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra'),
  uid: z.string().trim().max(64).optional(),
});

/**
 * Recepción desde la app del personal (camarero, encargado o dueño):
 *  - GET  /v1/reception/options       → qué se puede aquí (tarjeta, efectivo, fichas).
 *  - POST /v1/reception/cash          → recarga en efectivo: solo recepción (su puesto), el
 *    encargado (con su permiso «cobrar recargas en efectivo») o el dueño; lo comprueba el servicio.
 *  - GET  /v1/reception/cash/recent   → las recargas en efectivo que aún se pueden anular (encargado).
 *  - POST /v1/reception/cash/:id/void → anular una (encargado o dueño, con 2FA, si el saldo la cubre).
 *  - POST /v1/reception/lookup        → el NFC acercado o el código: de qué saldo es (sin enseñarlo).
 *  - POST /v1/reception/desk          → recepción exprés: el NFC o el código → nuevo o su saldo y lo que tiene.
 *  - POST /v1/reception/fichas/token  → código nuevo para grabar en una ficha vacía («Preparar fichas»).
 *  - POST /v1/reception/fichas/stock  → la ficha acercada, al stock del local.
 * Lo demás (ficha y PIN del saldo recién recargado) va por /v1/wallet-charges
 * como siempre: la recarga en efectivo cuenta como «la recarga es tuya».
 */
@Controller('reception')
@UseGuards(RolesGuard)
export class ReceptionController {
  private readonly cash: CashTopUpService;
  private readonly cards: WalletCardsService;
  private readonly charges: WalletChargesService;
  private readonly prisma: PrismaService;

  constructor(
    @Inject(CashTopUpService) cash: CashTopUpService,
    @Inject(WalletCardsService) cards: WalletCardsService,
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(PrismaService) prisma: PrismaService,
  ) {
    this.cash = cash;
    this.cards = cards;
    this.charges = charges;
    this.prisma = prisma;
  }

  /** También la chica: «Recargar saldo» en Inicio (con tarjeta; el efectivo, con su permiso). */
  @Get('options')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async options(@CurrentUser() user: JwtPayload): Promise<ReceptionOptions> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({
        where: { id: user.tenantId },
        select: { paymentMethods: true, ...VENUE_PAUSE_SELECT, ...VENUE_SERVICE_FEE_SELECT },
      }),
    );
    const methods = paymentMethodsOf(venue?.paymentMethods);
    const cashBlockedReason = await this.cash.cashBlockedReason(user.tenantId, { userId: user.sub, role: user.role });
    return {
      // En el móvil, con tarjeta es el QR de la recarga (el cliente paga en su móvil).
      card: venuePauseScope(venue) === null && methods.card && methods.wallet,
      cash: cashBlockedReason === null,
      cashBlockedReason,
      nfc: methods.nfc,
      // «Cobra 56 € (50 € de saldo + 6 € de comisión del servicio)».
      serviceFee: venueServiceFeeOf(venue),
    };
  }

  @Post('cash')
  @HttpCode(201)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-cash' })
  async cashTopUp(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CashTopUpSchema)) body: CashTopUpDto,
  ): Promise<CashTopUpResult> {
    // Recargar la ficha acercada (o dar una nueva al saldo nuevo) necesita «Fichas NFC» encendido (como lookup).
    if ('card' in body.wallet && body.wallet.card) {
      await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, user.tenantId, ['nfc']));
    }
    return this.cash.topUp(user.tenantId, { userId: user.sub, role: user.role }, body);
  }

  @Get('cash/recent')
  @Roles('MANAGER', 'OWNER')
  async recentCash(@CurrentUser() user: JwtPayload): Promise<RecentCashTopUp[]> {
    return this.cash.recent(user.tenantId);
  }

  @Post('cash/:id/void')
  @HttpCode(200)
  @Roles('MANAGER', 'OWNER')
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'reception-cash-void' })
  async voidCash(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(CashTopUpVoidSchema)) body: CashTopUpVoidDto,
  ): Promise<CashTopUpVoidResult> {
    return this.cash.voidTopUp({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id, body);
  }

  @Post('lookup')
  @HttpCode(200)
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-lookup' })
  async lookup(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(SaldoRefSchema)) body: SaldoRefDto,
  ): Promise<ReceptionCardView> {
    const ref = 'card' in body ? { card: body.card, uid: body.uid ?? null } : { code: body.code };
    return this.charges.lookupForReception(user.tenantId, ref);
  }

  /**
   * Recepción exprés: el NFC acercado o el código → nuevo o su saldo (lo que
   * tiene, su número y lo que se le puede devolver en efectivo). Solo quien
   * carga saldos (lo mira el servicio).
   */
  @Post('desk')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-lookup' })
  async desk(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(SaldoRefSchema)) body: SaldoRefDto,
  ): Promise<ReceptionDeskView> {
    const ref = 'card' in body ? { card: body.card, uid: body.uid ?? null } : { code: body.code };
    return this.cards.desk(user.tenantId, { userId: user.sub, role: user.role }, ref);
  }

  @Post('fichas/token')
  @HttpCode(201)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'reception-fichas' })
  async fichaToken(@CurrentUser() user: JwtPayload): Promise<{ card: string }> {
    return this.cards.newStockToken(user.tenantId, { userId: user.sub });
  }

  @Post('fichas/stock')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'reception-fichas' })
  async fichaStock(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CardSchema)) body: z.infer<typeof CardSchema>,
  ): Promise<StockOutcome> {
    return this.cards.stock(user.tenantId, { userId: user.sub }, { card: body.card, uid: body.uid ?? null });
  }
}
