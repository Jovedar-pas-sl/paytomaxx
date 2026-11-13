import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { PartyRefundAskSchema, type PartyRefundView } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { WalletChargesService } from '../wallets/wallet-charges.service';
import { WalletPasskeysService } from '../wallets/wallet-passkeys.service';
import { walletViewAccess } from '../wallets/wallet-view-access';
import { PartyEditionGuard } from './party-edition.guard';
import { PartyRefundsService } from './party-refunds.service';

/**
 * «Lo que sobra» desde la página de la pulsera (/w/:token, OxioParty; con
 * EDITION=club, 404). La credencial es la de la página: el enlace y, si el
 * saldo tiene Face ID, su sesión de consulta (como /state) y además su llave
 * al pedirlo (como «Me voy»: con solo el enlace no se manda el dinero a otro
 * IBAN). Topes por IP y por pulsera.
 *  - GET  /w/:token/sobra             lo que puede pedir y sus peticiones
 *  - POST /w/:token/sobra/challenge   reto para su llave (409 FACE_ID_NOT_SET sin Face ID)
 *  - POST /w/:token/sobra             pedirlo { method, iban?, email?, expectedAmountCents?, response? }
 */
@Controller('w')
@UseGuards(PartyEditionGuard)
export class PartyWalletController {
  constructor(
    @Inject(WalletChargesService) private readonly charges: WalletChargesService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
    @Inject(PartyRefundsService) private readonly refunds: PartyRefundsService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Public()
  @Get(':token/sobra')
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'party-sobra', failOpen: true })
  async view(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: FastifyReply,
    @Headers('cookie') cookies?: string,
  ): Promise<PartyRefundView> {
    const walletId = await this.unlocked(token, cookies, res);
    return this.refunds.view(walletId);
  }

  @Public()
  @Post(':token/sobra/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'party-sobra-key', perKey: { param: 'token', max: 10 } })
  async challenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    const wallet = await this.charges.walletRefByToken(token);
    if (!(await this.passkeys.hasPasskey(wallet.id))) {
      throw new ConflictException({ message: 'Este saldo no tiene Face ID', code: 'FACE_ID_NOT_SET' });
    }
    return this.passkeys.challenge(`sobra:${wallet.id}`, host);
  }

  @Public()
  @Post(':token/sobra')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'party-sobra-ask', perKey: { param: 'token', max: 5 } })
  async ask(
    @Param('token') token: string,
    @Body() body: Record<string, unknown> | undefined,
    @Headers('host') host: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
    @Headers('cookie') cookies?: string,
  ): Promise<PartyRefundView> {
    const walletId = await this.unlocked(token, cookies, res);
    const parsed = PartyRefundAskSchema.safeParse(body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestException({ message: issue?.message ?? 'Revisa los datos', code: 'REFUND_INVALID', field: issue?.path.join('.') || null });
    }
    // Con Face ID, su llave (atada a esta acción y a este saldo): el enlace solo no basta.
    await this.passkeys.assertOwner(walletId, `sobra:${walletId}`, host, body?.response);
    return this.refunds.ask(walletId, parsed.data);
  }

  /** El saldo, si se puede leer (sin Face ID, con el enlace; con él, con su sesión). */
  private async unlocked(token: string, cookies: string | undefined, res: FastifyReply): Promise<string> {
    const access = await walletViewAccess(
      {
        walletRefByToken: (value) => this.charges.walletRefByToken(value),
        hasPasskey: (id) => this.passkeys.hasPasskey(id),
        secret: this.config.get<string>('COOKIE_SECRET') ?? '',
      },
      token,
      cookies,
    );
    if (!access.allowed) throw new UnauthorizedException({ message: 'Desbloquea tu saldo con tu teléfono.', code: 'WALLET_VIEW_REQUIRED' });
    if (access.renew) res.header('Set-Cookie', access.renew);
    return (await this.charges.walletRefByToken(token)).id;
  }
}
