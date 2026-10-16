import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import {
  GoogleWalletService,
  type GoogleWalletSyncSummary,
} from '../wallets/google-wallet/google-wallet.service';
import { GOOGLE_WALLET_SYNC_EVERY_MS } from '../wallets/google-wallet/google-wallet-sync';
import { GOOGLE_WALLET_SYNC_QUEUE } from './queue-tokens';

/** Id del trabajo repetido en Redis (uno para todas las réplicas). */
export const GOOGLE_WALLET_SYNC_SCHEDULER = 'google-wallet-sync';

/** En pruebas, o apagado a mano (NIGHTPAY_DISABLE_GOOGLE_WALLET_SYNC=1), no corre. */
function syncDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.NIGHTPAY_DISABLE_GOOGLE_WALLET_SYNC === '1';
}

/**
 * Repaso de los pases de Google Wallet: pone al día los que cambiaron
 * (GoogleWalletService.syncDue). El worker no arranca solo (autorun: false):
 * sin Google Wallet configurado no corre nada.
 */
@Processor(GOOGLE_WALLET_SYNC_QUEUE, { autorun: false })
export class GoogleWalletSyncProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(GoogleWalletSyncProcessor.name);
  private readonly gwallet: GoogleWalletService;

  constructor(@Inject(GoogleWalletService) gwallet: GoogleWalletService) {
    super();
    this.gwallet = gwallet;
  }

  onApplicationBootstrap(): void {
    if (!this.gwallet.enabled || syncDisabled()) return;
    this.worker.run().catch((err: unknown) => {
      this.logger.error(`El repaso de Google Wallet se paró: ${(err as Error).message}`);
    });
  }

  async process(_job: Job): Promise<GoogleWalletSyncSummary> {
    return this.gwallet.syncDue();
  }
}

/**
 * Programa el repaso cada ~2 min (trabajo repetido de BullMQ: uno solo
 * aunque haya varias réplicas). Sin Google Wallet configurado lo quita, por
 * si estaba de antes. Nunca rompe el arranque.
 */
@Injectable()
export class GoogleWalletSyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(GoogleWalletSyncScheduler.name);
  private readonly queue: Queue;
  private readonly gwallet: GoogleWalletService;

  constructor(
    @InjectQueue(GOOGLE_WALLET_SYNC_QUEUE) queue: Queue,
    @Inject(GoogleWalletService) gwallet: GoogleWalletService,
  ) {
    this.queue = queue;
    this.gwallet = gwallet;
  }

  async onModuleInit(): Promise<void> {
    if (syncDisabled()) return;
    await this.schedule();
  }

  async schedule(): Promise<'scheduled' | 'removed' | 'failed'> {
    try {
      if (!this.gwallet.enabled) {
        await this.queue.removeJobScheduler(GOOGLE_WALLET_SYNC_SCHEDULER);
        return 'removed';
      }
      await this.queue.upsertJobScheduler(
        GOOGLE_WALLET_SYNC_SCHEDULER,
        { every: GOOGLE_WALLET_SYNC_EVERY_MS },
        { name: 'sync', data: {}, opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } } },
      );
      return 'scheduled';
    } catch (err) {
      this.logger.warn(`No se pudo programar el repaso de Google Wallet: ${(err as Error).message}`);
      return 'failed';
    }
  }
}
