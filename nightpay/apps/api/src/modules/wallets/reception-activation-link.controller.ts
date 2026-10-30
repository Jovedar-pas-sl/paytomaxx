import { Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { JwtPayload, WalletActivationLink } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { WalletActivationLinkService } from './wallet-activation-link.service';

/**
 * POST /v1/reception/wallets/:id/activation-link → { url, expiresAt } o 404.
 * El QR de activación de la pantalla «Cargado» (contrato: wallet-activation.ts
 * de @nightpay/contracts): cada petición emite un enlace de activación de un
 * solo uso (/w/a/<token>, 10 min) y anula el anterior sin usar; por eso es un
 * POST. El GET de antes hace lo mismo para las apps del personal que aún no se
 * han actualizado (quitarlo cuando no quede ninguna). Las chicas (OPERATOR) ni
 * llegan; el puesto lo mira el servicio. Los dos comparten el límite por IP.
 */
@Controller('reception')
@UseGuards(RolesGuard)
export class ReceptionActivationLinkController {
  constructor(@Inject(WalletActivationLinkService) private readonly links: WalletActivationLinkService) {}

  @Post('wallets/:id/activation-link')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-activation-link' })
  issue(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) walletId: string): Promise<WalletActivationLink> {
    return this.links.link({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId);
  }

  /** Lo mismo que el POST, para las apps de antes. */
  @Get('wallets/:id/activation-link')
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-activation-link' })
  activationLink(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) walletId: string): Promise<WalletActivationLink> {
    return this.issue(user, walletId);
  }
}
