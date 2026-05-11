import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '@nightpay/contracts';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { VivaSoftPosAdapter } from './viva-softpos.adapter';
import type { GatewayAdapter } from './gateway.adapter';

/**
 * Registry de adapters por Provider — un solo punto de resolución.
 * Mantiene el patrón ADR-005: nadie importa Wipay/Peanpe/Viva directo.
 */
@Injectable()
export class GatewayRegistry {
  private readonly adapters: Map<Provider, GatewayAdapter>;

  constructor(
    @Inject(WipayAdapter) wipay: WipayAdapter,
    @Inject(PeanpeAdapter) peanpe: PeanpeAdapter,
    @Inject(VivaSoftPosAdapter) viva: VivaSoftPosAdapter,
  ) {
    this.adapters = new Map<Provider, GatewayAdapter>([
      ['WIPAY', wipay],
      ['PEANPE', peanpe],
      ['VIVA_SOFTPOS', viva],
    ]);
  }

  get(provider: Provider): GatewayAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`No gateway adapter for provider=${provider}`);
    return adapter;
  }
}
