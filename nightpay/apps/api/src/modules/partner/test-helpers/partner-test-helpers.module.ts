import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { partnerTestHelpersEnabled } from '../../../config/partner-test-mode';
import { WalletLiveCodeModule } from '../../wallets/wallet-live-code.module';
import { PartnerModule } from '../partner.module';
import { PartnerTestHelpersController } from './partner-test-helpers.controller';

/**
 * Las ayudas de prueba de la demo (`/v1/partner/test/…`). Fuera de la demo
 * no se monta (primera barrera; la segunda es el freno de arranque de env.ts y
 * la tercera, el guard). PartnerModule exporta lo que piden el guard y el
 * interceptor; WalletLiveCodeModule, el código del móvil.
 */
@Module({
  imports: [WalletLiveCodeModule, PartnerModule],
  controllers: [PartnerTestHelpersController],
})
export class PartnerTestHelpersModule {}

/** Lo que esparcen app.module.ts y test/support/socios.ts: el módulo solo con las ayudas y la API en `test`. */
export function partnerTestHelpersImports(env: Readonly<Record<string, string | undefined>> = process.env): Array<Type | DynamicModule> {
  return partnerTestHelpersEnabled(env) ? [PartnerTestHelpersModule] : [];
}
