import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '@nightpay/contracts';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { PaytefAdapter } from './paytef.adapter';
import { RedsysAdapter } from './redsys.adapter';
import type { GatewayAdapter } from './gateway.adapter';

/**
 * Registry de adapters por Provider — un solo punto de resolución.
 * Mantiene el patrón ADR-005: nadie importa adapters concretos.
 */
@Injectable()
export class GatewayRegistry {
  private readonly adapters: Map<Provider, GatewayAdapter>;

  constructor(
    @Inject(WipayAdapter) wipay: WipayAdapter,
    @Inject(PeanpeAdapter) peanpe: PeanpeAdapter,
    @Inject(PaytefAdapter) paytef: PaytefAdapter,
    @Inject(RedsysAdapter) redsys: RedsysAdapter,
  ) {
    this.adapters = new Map<Provider, GatewayAdapter>([
      ['WIPAY', wipay],
      ['PEANPE', peanpe],
      ['PAYTEF', paytef],
      ['REDSYS', redsys],
    ]);
  }

  get(provider: Provider): GatewayAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`No gateway adapter for provider=${provider}`);
    return adapter;
  }
}
