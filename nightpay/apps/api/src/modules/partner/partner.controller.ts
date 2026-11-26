import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PARTNER_ROUTES, buildPartnerOpenApi, type PartnerConnection } from '@nightpay/contracts';
import { CurrentConnection, type PartnerAuth } from './auth/current-connection.decorator';
import { partnerTermsUrl, toConnectionView } from './connection-view';
import { PartnerRoute } from './http/partner-route.decorator';

/**
 * La API de socios: /v1/partner. Cada ruta, solo con @PartnerRoute(PARTNER_ROUTES.x)
 * (la clave, los permisos, los errores del contrato y lo que sale). Ver
 * docs/partner-api y modules/partner/README en el diseño.
 */
@Controller('partner')
export class PartnerController {
  private doc: Record<string, unknown> | null = null;
  private readonly termsUrl: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.termsUrl = partnerTermsUrl(config.get<string>('NEXT_PUBLIC_API_URL'));
  }

  @PartnerRoute(PARTNER_ROUTES.getConnection)
  me(@CurrentConnection() auth: PartnerAuth): PartnerConnection {
    return toConnectionView(auth, this.termsUrl);
  }

  @PartnerRoute(PARTNER_ROUTES.getOpenApi)
  openApi(): Record<string, unknown> {
    this.doc ??= buildPartnerOpenApi();
    return this.doc;
  }
}
