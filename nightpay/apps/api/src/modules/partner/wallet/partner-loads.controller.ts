import { Body, Controller, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { PARTNER_ROUTES, type StatementBody, type WalletLoadBody, type WalletLoadListBody } from '@nightpay/contracts';
import { CurrentConnection, type PartnerAuth } from '../auth/current-connection.decorator';
import { partnerReceivedAt, type PartnerTimedRequest } from '../http/partner-hooks';
import { PartnerRoute } from '../http/partner-route.decorator';
import { PartnerLoadsService } from './partner-loads.service';

interface HeaderReply {
  header(key: string, value: string): unknown;
}

/**
 * Las cargas de saldo de los socios (PR 3): `POST /wallet/loads` (cargar),
 * `GET /wallet/loads/{id}`, `POST /wallet/loads/{id}/void` (anular en 10
 * minutos), `GET /wallet/operations` y `GET /statement`. Todas con
 * `wallet:load`; crear y anular mueven dinero (congelación y 120/min). El
 * cuerpo se valida en el servicio, después de la `Idempotency-Key`.
 */
@Controller('partner')
export class PartnerLoadsController {
  constructor(@Inject(PartnerLoadsService) private readonly loads: PartnerLoadsService) {}

  @PartnerRoute(PARTNER_ROUTES.createWalletLoad)
  async create(
    @CurrentConnection() auth: PartnerAuth,
    @Req() req: PartnerTimedRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
    @Body() body: unknown,
  ): Promise<WalletLoadBody> {
    const out = await this.loads.create(auth, req.headers, body, partnerReceivedAt(req));
    if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    return out.body;
  }

  @PartnerRoute(PARTNER_ROUTES.getWalletLoad)
  get(@CurrentConnection() auth: PartnerAuth, @Param('id') id: string): Promise<WalletLoadBody> {
    return this.loads.get(auth, id);
  }

  @PartnerRoute(PARTNER_ROUTES.voidWalletLoad)
  voidLoad(
    @CurrentConnection() auth: PartnerAuth,
    @Param('id') id: string,
    @Req() req: PartnerTimedRequest,
    @Body() body: unknown,
  ): Promise<WalletLoadBody> {
    return this.loads.voidByPartner(auth, id, body, partnerReceivedAt(req));
  }

  @PartnerRoute(PARTNER_ROUTES.listWalletOperations)
  list(@CurrentConnection() auth: PartnerAuth, @Query() query: Record<string, unknown>): Promise<WalletLoadListBody> {
    return this.loads.list(auth, query);
  }

  @PartnerRoute(PARTNER_ROUTES.getStatement)
  statement(@CurrentConnection() auth: PartnerAuth, @Query() query: Record<string, unknown>): Promise<StatementBody> {
    return this.loads.statement(auth, query);
  }
}
