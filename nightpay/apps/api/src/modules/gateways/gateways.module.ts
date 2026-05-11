import { Global, Module } from '@nestjs/common';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { VivaSoftPosAdapter } from './viva-softpos.adapter';
import { GatewayRegistry } from './gateway.registry';

@Global()
@Module({
  providers: [WipayAdapter, PeanpeAdapter, VivaSoftPosAdapter, GatewayRegistry],
  exports: [WipayAdapter, PeanpeAdapter, VivaSoftPosAdapter, GatewayRegistry],
})
export class GatewaysModule {}
