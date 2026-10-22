import { Controller, Get, Header, Inject, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import type { JwtPayload, WalletActivationLink } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { WalletActivationLinkService } from './wallet-activation-link.service';

/**
 * GET /v1/reception/wallets/:id/activation-link → { url, expiresAt } o 404.
 * El QR de activación de la pantalla «Cargado» (contrato: wallet-activation.ts
 * de @nightpay/contracts). Las chicas (OPERATOR) ni llegan; el puesto lo mira el servicio.
 */
@Controller('reception')
@UseGuards(RolesGuard)
export class ReceptionActivationLinkController {
  constructor(@Inject(WalletActivationLinkService) private readonly links: WalletActivationLinkService) {}

  @Get('wallets/:id/activation-link')
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-activation-link' })
  activationLink(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) walletId: string): Promise<WalletActivationLink> {
    return this.links.link({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId);
  }
}
