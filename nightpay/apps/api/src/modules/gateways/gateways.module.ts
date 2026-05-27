import { Global, Module } from '@nestjs/common';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { PaytefAdapter } from './paytef.adapter';
import { RedsysAdapter } from './redsys.adapter';
import { GatewayRegistry } from './gateway.registry';

@Global()
@Module({
  providers: [WipayAdapter, PeanpeAdapter, PaytefAdapter, RedsysAdapter, GatewayRegistry],
  exports: [WipayAdapter, PeanpeAdapter, PaytefAdapter, RedsysAdapter, GatewayRegistry],
})
export class GatewaysModule {}
