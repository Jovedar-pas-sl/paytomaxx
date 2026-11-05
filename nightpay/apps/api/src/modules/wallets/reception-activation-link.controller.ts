import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { JwtPayload, WalletActivationLink } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { WalletActivationLinkService } from './wallet-activation-link.service';

/** La ficha que recepción acaba de leer (un saldo que ya tenía dinero, sin PIN, la pide). */
const ActivationProofSchema = z
  .object({ card: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(), uid: z.string().trim().max(64).optional() })
  .optional();

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
  issue(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(ActivationProofSchema)) body?: z.infer<typeof ActivationProofSchema>,
  ): Promise<WalletActivationLink> {
    return this.links.link({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId, new Date(), body ?? {});
  }

  /** Lo mismo que el POST, para las apps de antes. */
  @Get('wallets/:id/activation-link')
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-activation-link' })
  activationLink(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) walletId: string): Promise<WalletActivationLink> {
    return this.issue(user, walletId, {});
  }
}
