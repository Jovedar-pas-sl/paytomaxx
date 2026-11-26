import { Global, Module } from '@nestjs/common';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { PaytefAdapter } from './paytef.adapter';
import { RedsysAdapter } from './redsys.adapter';
import { BtcpayAdapter } from './btcpay.adapter';
import { YavinAdapter } from './yavin.adapter';
import { GatewayRegistry } from './gateway.registry';

@Global()
@Module({
  providers: [WipayAdapter, PeanpeAdapter, PaytefAdapter, RedsysAdapter, BtcpayAdapter, YavinAdapter, GatewayRegistry],
  exports: [WipayAdapter, PeanpeAdapter, PaytefAdapter, RedsysAdapter, BtcpayAdapter, YavinAdapter, GatewayRegistry],
})
export class GatewaysModule {}
