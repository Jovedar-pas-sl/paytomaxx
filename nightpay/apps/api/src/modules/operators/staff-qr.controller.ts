import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import type { JwtPayload, StaffQrView } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { operatorAppBaseUrl } from './operator-app-url';
import { signStaffToken, staffQrSecret } from './staff-qr';

/**
 * «Mi QR» (Invitar a una copa):
 *  - GET /v1/operators/me/staff-qr → el QR personal de la chica, firmado y de
 *    vida corta (la app lo renueva). Lleva la app del personal con
 *    ?invita=<token>: el camarero lo escanea con su app o con la cámara.
 */
@Controller('operators')
@UseGuards(RolesGuard)
export class StaffQrController {
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  @Get('me/staff-qr')
  @Roles('OPERATOR')
  async myStaffQr(@CurrentUser() user: JwtPayload): Promise<StaffQrView> {
    const { token, expiresAt } = signStaffToken({ userId: user.sub, tenantId: user.tenantId }, Date.now(), staffQrSecret());
    const base = operatorAppBaseUrl({
      operatorBaseUrl: this.config.get<string>('OPERATOR_BASE_URL'),
      operatorUrl: this.config.get<string>('NEXT_PUBLIC_OPERATOR_URL'),
      apiUrl: this.config.get<string>('NEXT_PUBLIC_API_URL'),
      production: this.config.get<string>('NODE_ENV') === 'production',
    });
    const url = base ? `${base}/?invita=${token}` : token;
    const qrPngDataUrl = await QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: 'M' });
    return { url, token, qrPngDataUrl, expiresAt: expiresAt.toISOString() };
  }
}
