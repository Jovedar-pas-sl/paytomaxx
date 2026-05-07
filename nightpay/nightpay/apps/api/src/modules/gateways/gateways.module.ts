import { Global, Module } from '@nestjs/common';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { StripeAdapter } from './stripe.adapter';
import { GatewayRegistry } from './gateway.registry';

@Global()
@Module({
  providers: [WipayAdapter, PeanpeAdapter, StripeAdapter, GatewayRegistry],
  exports: [WipayAdapter, PeanpeAdapter, StripeAdapter, GatewayRegistry],
})
export class GatewaysModule {}
