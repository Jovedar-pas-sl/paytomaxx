import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PartnerAuthLimiter } from './auth/partner-auth-limiter';
import { PartnerForeignIpService } from './auth/partner-foreign-ip';
import { PartnerFreezeService } from './auth/partner-freeze';
import { PartnerKeyGuard } from './auth/partner-key.guard';
import { PartnerRateLimiter } from './auth/partner-rate-limit';
import { PartnerKeyExposureService } from './http/partner-key-exposure.service';
import { PartnerResponseInterceptor } from './http/partner-response.interceptor';
import { PartnerController } from './partner.controller';

/**
 * API de socios (/v1/partner): otras plataformas con una clave por local.
 * Siempre importado (como BtcpayModule): con PARTNER_API_ENABLED apagado (de
 * serie) o en OxioParty sus rutas dan 404 y el repaso no corre. La consola del
 * super-admin (socios, congelación) está en modules/superadmin/partners.*.
 */
@Module({
  imports: [AuthModule],
  controllers: [PartnerController],
  providers: [
    PartnerAuthLimiter,
    PartnerRateLimiter,
    PartnerFreezeService,
    PartnerForeignIpService,
    PartnerKeyGuard,
    PartnerResponseInterceptor,
    PartnerKeyExposureService,
  ],
  exports: [PartnerFreezeService, PartnerAuthLimiter, PartnerRateLimiter, PartnerForeignIpService, PartnerKeyExposureService],
})
export class PartnerModule {}
