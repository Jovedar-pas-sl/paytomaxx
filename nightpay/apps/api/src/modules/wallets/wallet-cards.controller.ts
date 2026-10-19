import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import type { FichasSummary, JwtPayload, WalletCardRow } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { WalletCardsService } from './wallet-cards.service';

/**
 * Fichas NFC del local en el panel (Clientes → Fichas), encargado o dueño:
 *  - GET  /v1/wallet-cards?q=&status=   → la lista (búsqueda por número de serie o código).
 *  - GET  /v1/wallet-cards/summary      → en stock, entregadas y lo de cada noche.
 *  - POST /v1/wallet-cards/:id/block    → bloquearla (ya no paga).
 *  - POST /v1/wallet-cards/:id/lost     → marcarla perdida (ya no paga, sale del stock).
 */
@Controller('wallet-cards')
@UseGuards(RolesGuard)
export class WalletCardsController {
  private readonly cards: WalletCardsService;

  constructor(@Inject(WalletCardsService) cards: WalletCardsService) {
    this.cards = cards;
  }

  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(
    @CurrentUser() user: JwtPayload,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ): Promise<WalletCardRow[]> {
    return this.cards.list(user.tenantId, { q: typeof q === 'string' ? q.slice(0, 64) : undefined, status });
  }

  @Get('summary')
  @Roles('OWNER', 'MANAGER')
  async summary(@CurrentUser() user: JwtPayload): Promise<FichasSummary> {
    return this.cards.summary(user.tenantId);
  }

  @Post(':id/block')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  async block(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<WalletCardRow> {
    return this.cards.mark({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id, 'block');
  }

  @Post(':id/lost')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  async lost(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<WalletCardRow> {
    return this.cards.mark({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id, 'lost');
  }
}
