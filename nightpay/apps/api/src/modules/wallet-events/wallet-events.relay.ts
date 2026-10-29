import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { WalletEventsListener } from './wallet-events.listener';
import { WalletStreamHub } from './wallet-stream.hub';

/**
 * Cada aviso de Postgres (WalletEventsListener), a quien lo espera en ESTA
 * réplica: «el saldo cambió» a sus páginas abiertas (WalletStreamHub, SSE) y
 * «el cobro del saldo cambió» a la app del personal que lo sigue
 * (RealtimeGateway, solo a los sockets de aquí). Si la escucha se cortó y
 * volvió, todas las páginas se ponen al día. Sin RealtimeGateway (pruebas que
 * montan solo un trozo de la app; en el API siempre está, es global), los
 * avisos de cobros no van a ningún sitio y la app sigue con su sondeo.
 */
@Injectable()
export class WalletEventsRelay implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: Array<() => void> = [];

  constructor(
    @Inject(WalletEventsListener) private readonly listener: WalletEventsListener,
    @Inject(WalletStreamHub) private readonly hub: WalletStreamHub,
    @Optional() @Inject(RealtimeGateway) private readonly gateway?: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = [
      this.listener.onEvent((event) => {
        if (event.kind === 'wallet') this.hub.notify(event.walletId);
        else this.gateway?.emitWalletChargeUpdate(event.chargeId, event.status);
      }),
      this.listener.onResync(() => this.hub.resync()),
    ];
  }

  onModuleDestroy(): void {
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
  }
}
