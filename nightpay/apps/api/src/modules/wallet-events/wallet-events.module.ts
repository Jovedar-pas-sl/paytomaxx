import { Module } from '@nestjs/common';
import { WalletEventsListener } from './wallet-events.listener';
import { WalletEventsRelay } from './wallet-events.relay';
import { WalletStreamHub } from './wallet-stream.hub';

/**
 * «Saldo al momento» (H-1, H-2): los avisos de Postgres (triggers +
 * pg_notify, migración 20261102100000_saldo_al_momento), la conexión que los
 * escucha en cada réplica y su reparto a las páginas del saldo (SSE) y a la
 * app del personal (RealtimeGateway, global). Lo importa WalletsModule (la
 * ruta GET /w/:token/events usa WalletStreamHub).
 */
@Module({
  providers: [WalletEventsListener, WalletStreamHub, WalletEventsRelay],
  exports: [WalletStreamHub, WalletEventsListener],
})
export class WalletEventsModule {}
