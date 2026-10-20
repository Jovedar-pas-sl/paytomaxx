import { Controller, Get, Header, Inject, NotFoundException, Param, Redirect } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WALLET_PASS_PARAM, WALLET_PASS_SEGMENT, isPassChargeToken } from '@nightpay/contracts';
import { Public } from '../../../common/decorators/public.decorator';
import { IpRateLimit } from '../../../common/guards/ip-rate-limit.guard';
import { operatorAppBaseUrl } from '../../operators/operator-app-url';

/**
 * GET /c/:token (fuera de /v1): el QR del pase de Google Wallet leído con la
 * cámara normal de un móvil. Lleva a la app del personal con ?pase=<token>,
 * donde la chica le cobra con el PIN del cliente (el cobro que tenga abierto).
 *
 * Aquí no se mira la base ni la firma (eso lo hace el API al cobrar, con la
 * sesión de la chica): solo la forma del token, y no se abre nada del saldo.
 * Así esta ruta tampoco dice si un token vale o no.
 */
@Controller(WALLET_PASS_SEGMENT)
export class PassChargeLinkController {
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  @Public()
  @Get(':token')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-pass-link' })
  open(@Param('token') token: string): { url: string; statusCode: number } {
    const app = operatorAppBaseUrl({
      operatorBaseUrl: this.config.get<string>('OPERATOR_BASE_URL'),
      operatorUrl: this.config.get<string>('NEXT_PUBLIC_OPERATOR_URL'),
      apiUrl: this.config.get<string>('NEXT_PUBLIC_API_URL'),
      production: this.config.get<string>('NODE_ENV') === 'production',
    });
    if (!isPassChargeToken(token) || !app) throw new NotFoundException();
    return { url: `${app}/?${WALLET_PASS_PARAM}=${token}`, statusCode: 302 };
  }
}
