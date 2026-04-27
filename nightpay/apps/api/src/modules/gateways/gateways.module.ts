import { Global, Module } from '@nestjs/common';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { GatewayRegistry } from './gateway.registry';

@Global()
@Module({
  providers: [WipayAdapter, PeanpeAdapter, GatewayRegistry],
  exports: [WipayAdapter, PeanpeAdapter, GatewayRegistry],
})
export class GatewaysModule {}
