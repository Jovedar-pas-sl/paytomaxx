import { Body, Controller, Header, Headers, HttpCode, Inject, NotFoundException, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { liveWalletId } from './wallet-merge-chain';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { walletViewSetCookies } from './wallet-view-session';

/** El reto vale solo para «Ver mi saldo». */
const MINE_SCOPE = 'wallet-mine';

/**
 * «Ver mi saldo» desde las pantallas del cliente que no saben de quién es el
 * saldo (my-balance.ts): el cliente desbloquea su móvil y va a SU saldo (el
 * de su llave o, si se sumó a otro, aquel), con la sesión de consulta abierta
 * como en /w/card/:token/view. Solo la llave dice qué saldo es.
 *  - POST /w/mine/challenge → reto para la llave del cliente.
 *  - POST /w/mine           → { url: '/w/<enlace>' } y la cookie de consulta.
 */
@Controller('w')
export class PublicWalletMineController {
  constructor(
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('mine/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-mine' })
  challenge(@Headers('host') host: string | undefined): Promise<unknown> {
    return this.passkeys.challenge(MINE_SCOPE, host);
  }

  @Public()
  @Post('mine')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-mine' })
  async open(
    @Headers('host') host: string | undefined,
    @Body() body: { response?: unknown } | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ url: string }> {
    const keyWalletId = await this.passkeys.verify(MINE_SCOPE, host, body?.response);
    const wallet = await this.prisma.acrossVenues(async (tx) => {
      const id = await liveWalletId(tx, keyWalletId);
      return id ? tx.clientWallet.findUnique({ where: { id }, select: { id: true, qrToken: true } }) : null;
    });
    if (!wallet) throw new NotFoundException({ message: 'Este saldo ya no existe', code: 'WALLET_NOT_FOUND' });
    res.header('Set-Cookie', walletViewSetCookies(this.config.get<string>('COOKIE_SECRET') ?? '', wallet));
    return { url: `/w/${encodeURIComponent(wallet.qrToken)}` };
  }
}
