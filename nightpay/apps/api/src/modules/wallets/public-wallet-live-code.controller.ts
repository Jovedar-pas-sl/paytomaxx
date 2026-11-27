import { Controller, Header, Headers, HttpCode, Inject, Param, Post, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { PartnerApiEnabledGuard } from '../partner/partner-flag';
import { WalletChargesService } from './wallet-charges.service';
import { WalletLiveCodeService, type IssuedLiveCode } from './wallet-live-code.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { walletViewAccess } from './wallet-view-access';

/**
 * POST /w/:token/live-code — «Pagar o recargar en otro sistema»: un código
 * del móvil (`OXC1:`, 60 s, solo identifica) para que lo lea otra plataforma
 * conectada (API de socios, el cajero del local). Con la API apagada o en
 * OxioParty, 404. El mismo acceso que /state: el enlace y, si el saldo tiene
 * Face ID, su sesión de consulta (401 WALLET_VIEW_REQUIRED; pedirlo la
 * alarga). No lee el cuerpo.
 *
 * Tope por IP de 300 por minuto (muchos clientes comparten IP en el wifi del
 * local o en su operador) y de 6 por enlace: la página pide uno cada 45 s.
 */
@Controller('w')
export class PublicWalletLiveCodeController {
  constructor(
    @Inject(WalletChargesService) private readonly charges: WalletChargesService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
    @Inject(WalletLiveCodeService) private readonly liveCodes: WalletLiveCodeService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Public()
  @UseGuards(PartnerApiEnabledGuard)
  @Post(':token/live-code')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 300, windowSec: 60, scope: 'wallet-live-code', perKey: { param: 'token', max: 6 } })
  async issue(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: FastifyReply,
    @Headers('cookie') cookies?: string,
  ): Promise<IssuedLiveCode> {
    const wallet = await this.charges.walletRefByToken(token);
    const access = await walletViewAccess(
      {
        walletRefByToken: async () => wallet,
        hasPasskey: (id) => this.passkeys.hasPasskey(id),
        secret: this.config.get<string>('COOKIE_SECRET') ?? '',
      },
      token,
      cookies,
    );
    if (!access.allowed) throw new UnauthorizedException({ message: 'Desbloquea tu saldo con tu teléfono.', code: 'WALLET_VIEW_REQUIRED' });
    if (access.renew) res.header('Set-Cookie', access.renew);
    return this.liveCodes.issue(wallet.id);
  }
}
