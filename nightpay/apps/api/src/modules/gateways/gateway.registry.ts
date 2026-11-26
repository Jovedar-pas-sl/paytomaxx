import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Provider } from '@nightpay/contracts';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { PaytefAdapter } from './paytef.adapter';
import { RedsysAdapter } from './redsys.adapter';
import { BtcpayAdapter } from './btcpay.adapter';
import { YavinAdapter } from './yavin.adapter';
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
    // Bitcoin (BTCPay): no es la pasarela de tarjeta del local; solo para lo que el resto del API pide a toda pasarela.
    @Optional() @Inject(BtcpayAdapter) btcpay?: BtcpayAdapter,
    // Yavin (enlace de pago con QR). Siempre registrado: YAVIN_ENABLED solo impide
    // abrir enlaces NUEVOS (lo comprueba el propio adapter en authorize y la
    // elección de pasarela); los intentos ya guardados se siguen comprobando,
    // anulando y devolviendo aunque se apague.
    @Optional() @Inject(YavinAdapter) yavin?: YavinAdapter,
  ) {
    this.adapters = new Map<Provider, GatewayAdapter>([
      ['WIPAY', wipay],
      ['PEANPE', peanpe],
      ['PAYTEF', paytef],
      ['REDSYS', redsys],
      ...(btcpay ? ([['BTCPAY', btcpay]] as Array<[Provider, GatewayAdapter]>) : []),
      ...(yavin ? ([['YAVIN', yavin]] as Array<[Provider, GatewayAdapter]>) : []),
    ]);
  }

  get(provider: Provider): GatewayAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`No gateway adapter for provider=${provider}`);
    return adapter;
  }
}
