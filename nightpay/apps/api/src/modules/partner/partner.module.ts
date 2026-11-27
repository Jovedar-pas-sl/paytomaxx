import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PartnerAuthLimiter } from './auth/partner-auth-limiter';
import { PartnerForeignIpService } from './auth/partner-foreign-ip';
import { PartnerFreezeService } from './auth/partner-freeze';
import { PartnerKeyGuard } from './auth/partner-key.guard';
import { PartnerRateLimiter } from './auth/partner-rate-limit';
import { OwnerPartnerConnectionsController } from './connections/owner-partner-connections.controller';
import { PartnerConnectionsService } from './connections/partner-connections.service';
import { PartnerKeyClaimController } from './connections/partner-key-claim.controller';
import { PartnerKeyClaimService } from './connections/partner-key-claim.service';
import { PartnerKeySweepService } from './connections/partner-key-sweep.service';
import { PartnerKeyExposureService } from './http/partner-key-exposure.service';
import { PartnerResponseInterceptor } from './http/partner-response.interceptor';
import { PartnerController } from './partner.controller';
import { ChargeAlertModule } from '../wallets/charge-alert/charge-alert.module';
import { WalletLiveCodeModule } from '../wallets/wallet-live-code.module';
import { PartnerLoadWatch } from './wallet/partner-load-watch';
import { PartnerLoadsController } from './wallet/partner-loads.controller';
import { PartnerLoadsService } from './wallet/partner-loads.service';
import { PartnerWalletController } from './wallet/partner-wallet.controller';
import { PartnerWalletLimits } from './wallet/partner-wallet-limits';
import { PartnerWalletRefs } from './wallet/partner-wallet-ref';

/**
 * API de socios (/v1/partner): otras plataformas con una clave por local.
 * Siempre importado (como BtcpayModule): con PARTNER_API_ENABLED apagado (de
 * serie) o en OxioParty sus rutas dan 404 y el repaso no corre. La consola del
 * super-admin (socios, congelación) está en modules/superadmin/partners.*.
 */
@Module({
  // WalletLiveCodeModule: leer los códigos del móvil (no todo WalletsModule).
  // ChargeAlertModule: «Carga anulada» al móvil del cliente.
  imports: [AuthModule, WalletLiveCodeModule, ChargeAlertModule],
  controllers: [PartnerController, PartnerWalletController, PartnerLoadsController, OwnerPartnerConnectionsController, PartnerKeyClaimController],
  providers: [
    PartnerAuthLimiter,
    PartnerRateLimiter,
    PartnerFreezeService,
    PartnerForeignIpService,
    PartnerKeyGuard,
    PartnerResponseInterceptor,
    PartnerKeyExposureService,
    PartnerConnectionsService,
    PartnerKeyClaimService,
    PartnerKeySweepService,
    PartnerWalletLimits,
    PartnerWalletRefs,
    PartnerLoadWatch,
    PartnerLoadsService,
  ],
  exports: [PartnerFreezeService, PartnerAuthLimiter, PartnerRateLimiter, PartnerForeignIpService, PartnerKeyExposureService],
})
export class PartnerModule {}
