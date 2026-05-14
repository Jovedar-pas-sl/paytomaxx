import { Global, Module } from '@nestjs/common';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { PaytefAdapter } from './paytef.adapter';
import { GatewayRegistry } from './gateway.registry';

@Global()
@Module({
  providers: [WipayAdapter, PeanpeAdapter, PaytefAdapter, GatewayRegistry],
  exports: [WipayAdapter, PeanpeAdapter, PaytefAdapter, GatewayRegistry],
})
export class GatewaysModule {}
