import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import {
  CashTopUpSchema,
  paymentMethodsOf,
  type CashTopUpDto,
  type CashTopUpResult,
  type JwtPayload,
  type ReceptionOptions,
  type StockOutcome,
} from '@nightpay/contracts';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequiresPermission, StaffPermissionGuard } from '../venues/staff-permission.guard';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { venuePauseScope, VENUE_PAUSE_SELECT } from '../venues/venue-pause';
import { CashTopUpService } from './wallet-cash-topup.service';
import { WalletCardsService } from './wallet-cards.service';
import { WalletChargesService, type ReceptionCardView } from './wallet-charges.service';

const CardSchema = z.object({
  card: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra'),
  uid: z.string().trim().max(64).optional(),
});

/**
 * Recepción desde la app del personal (camarero, encargado o dueño):
 *  - GET  /v1/reception/options       → qué se puede aquí (tarjeta, efectivo, fichas).
 *  - POST /v1/reception/cash          → recarga en efectivo (permiso «cobrar recargas en efectivo»).
 *  - POST /v1/reception/lookup        → la ficha acercada: de qué saldo es (sin enseñarlo).
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

  @Get('options')
  @Roles('WAITER', 'MANAGER', 'OWNER')
  async options(@CurrentUser() user: JwtPayload): Promise<ReceptionOptions> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({ where: { id: user.tenantId }, select: { paymentMethods: true, ...VENUE_PAUSE_SELECT } }),
    );
    const methods = paymentMethodsOf(venue?.paymentMethods);
    const cashBlockedReason = await this.cash.cashBlockedReason(user.tenantId, { userId: user.sub, role: user.role });
    return {
      // En el móvil, con tarjeta es el QR de la recarga (el cliente paga en su móvil).
      card: venuePauseScope(venue) === null && methods.card && methods.wallet,
      cash: cashBlockedReason === null,
      cashBlockedReason,
      nfc: methods.nfc,
    };
  }

  @Post('cash')
  @HttpCode(201)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @UseGuards(StaffPermissionGuard)
  @RequiresPermission('cashTopUp')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-cash' })
  async cashTopUp(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CashTopUpSchema)) body: CashTopUpDto,
  ): Promise<CashTopUpResult> {
    // Recargar la ficha acercada necesita «Fichas NFC» encendido (como lookup).
    if ('card' in body.wallet) {
      await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, user.tenantId, ['nfc']));
    }
    return this.cash.topUp(user.tenantId, { userId: user.sub, role: user.role }, body);
  }

  @Post('lookup')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-lookup' })
  async lookup(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CardSchema)) body: z.infer<typeof CardSchema>,
  ): Promise<ReceptionCardView> {
    return this.charges.lookupCardForReception(user.tenantId, { card: body.card, uid: body.uid ?? null });
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
