import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { WALLET_EVENTS_CHANNEL, listenerConnectionString, parseWalletEvent, type WalletEvent } from './wallet-events';

/** Lo que se usa del cliente de Postgres (pg.Client) para escuchar. */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(): unknown;
}

export type ListenClientFactory = (connectionString: string) => ListenClient;

/** Para las pruebas: otro cliente en vez de pg.Client. */
export const LISTEN_CLIENT_FACTORY = Symbol('LISTEN_CLIENT_FACTORY');

/** Primera espera tras un fallo; se dobla en cada uno, hasta el tope. */
export const LISTEN_RETRY_MIN_MS = 1_000;
export const LISTEN_RETRY_MAX_MS = 30_000;
/** Cada cuánto se comprueba que la conexión sigue viva (un corte a medias no avisa). */
export const LISTEN_PING_MS = 30_000;
/** Lo que puede tardar esa comprobación antes de dar la conexión por perdida. */
export const LISTEN_PING_TIMEOUT_MS = 10_000;

const defaultFactory: ListenClientFactory = (connectionString) =>
  new Client({ connectionString, keepAlive: true }) as unknown as ListenClient;

/**
 * La conexión de ESTA réplica que escucha los avisos del saldo
 * (wallet-events.ts). Una sola, dedicada (fuera del pool de Prisma: una
 * conexión con LISTEN no se puede compartir). Reparte cada aviso a quien se
 * apunte con onEvent (las páginas abiertas por SSE y los sockets del
 * personal).
 *
 * Nunca impide arrancar ni cobrar: sin base, con la base caída o con el
 * aviso apagado (NIGHTPAY_DISABLE_WALLET_EVENTS=1), las páginas y la app
 * siguen con su sondeo de respaldo. Si la conexión se corta, vuelve a
 * conectar con espera creciente (1 s → 30 s) y, al volver, pide a todos que
 * se pongan al día (onResync): los avisos de mientras se perdieron.
 *
 * WALLET_EVENTS_DATABASE_URL: otra URL para escuchar (p. ej. directa a
 * Postgres si DATABASE_URL pasa por un PgBouncer en modo transacción, donde
 * LISTEN no funciona). Sin ella, DATABASE_URL. Vale con el superusuario `np`
 * y con un rol sin superusuario (LISTEN no pide permisos).
 */
@Injectable()
export class WalletEventsListener implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WalletEventsListener.name);
  private readonly url: string | null;
  private readonly factory: ListenClientFactory;
  private readonly eventHandlers = new Set<(event: WalletEvent) => void>();
  private readonly resyncHandlers = new Set<() => void>();
  private client: ListenClient | null = null;
  private connecting = false;
  private stopped = false;
  private everConnected = false;
  private retryMs = LISTEN_RETRY_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Optional() @Inject(LISTEN_CLIENT_FACTORY) factory?: ListenClientFactory,
  ) {
    const disabled = config.get<string>('NIGHTPAY_DISABLE_WALLET_EVENTS')?.trim() === '1';
    const raw = config.get<string>('WALLET_EVENTS_DATABASE_URL')?.trim() || config.get<string>('DATABASE_URL')?.trim();
    this.url = disabled || !raw ? null : safeConnectionString(raw);
    this.factory = factory ?? defaultFactory;
    if (disabled) this.logger.warn('Avisos del saldo apagados (NIGHTPAY_DISABLE_WALLET_EVENTS=1): las páginas siguen con el sondeo de respaldo');
  }

  /** Cada aviso del canal. Devuelve cómo dejar de escuchar. */
  onEvent(handler: (event: WalletEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** Volvió la conexión tras un corte: los avisos de mientras se perdieron. */
  onResync(handler: () => void): () => void {
    this.resyncHandlers.add(handler);
    return () => this.resyncHandlers.delete(handler);
  }

  /** La conexión está escuchando ahora. */
  get listening(): boolean {
    return this.client !== null;
  }

  onApplicationBootstrap(): void {
    if (!this.url) return;
    void this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopPing();
    const client = this.client;
    this.client = null;
    if (client) await closeQuietly(client);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.client || !this.url) return;
    this.connecting = true;
    const client = this.factory(this.url);
    client.on('notification', (msg) => {
      if (this.client === client) this.dispatch(msg);
    });
    client.on('error', (err) => this.lost(client, err));
    client.on('end', () => this.lost(client, null));
    try {
      await client.connect();
      await client.query(`LISTEN ${WALLET_EVENTS_CHANNEL}`);
      if (this.stopped) {
        await closeQuietly(client);
        return;
      }
      this.client = client;
      this.retryMs = LISTEN_RETRY_MIN_MS;
      this.startPing(client);
      this.logger.log(this.everConnected ? 'Avisos del saldo: conexión recuperada' : 'Avisos del saldo: escuchando');
      if (this.everConnected) this.emitResync();
      this.everConnected = true;
    } catch (err) {
      this.logger.warn(`Avisos del saldo: no se pudo escuchar (${(err as Error).message}); se reintenta`);
      await closeQuietly(client);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  /** La conexión se cayó (o la damos por caída): fuera y a reconectar. */
  private lost(client: ListenClient, err: Error | null): void {
    if (this.client !== client) return;
    this.client = null;
    this.stopPing();
    void closeQuietly(client);
    if (this.stopped) return;
    this.logger.warn(`Avisos del saldo: conexión perdida${err ? ` (${err.message})` : ''}; se reintenta`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    // Con algo de azar: las réplicas no vuelven todas a la vez.
    const wait = Math.round(this.retryMs * (0.5 + Math.random() / 2));
    this.retryMs = Math.min(this.retryMs * 2, LISTEN_RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
    this.retryTimer.unref?.();
  }

  /** Un SELECT 1 de vez en cuando: un corte de red a medias no avisa solo. */
  private startPing(client: ListenClient): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('la comprobación de la conexión no contesta')), LISTEN_PING_TIMEOUT_MS);
      });
      Promise.race([client.query('SELECT 1'), timeout])
        .catch((err: unknown) => this.lost(client, err as Error))
        .finally(() => clearTimeout(timer));
    }, LISTEN_PING_MS);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private dispatch(msg: { channel: string; payload?: string }): void {
    if (msg.channel !== WALLET_EVENTS_CHANNEL) return;
    const event = parseWalletEvent(msg.payload);
    if (!event) return;
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        this.logger.error(`Avisos del saldo: fallo al repartir un aviso: ${(err as Error).message}`);
      }
    }
  }

  private emitResync(): void {
    for (const handler of this.resyncHandlers) {
      try {
        handler();
      } catch (err) {
        this.logger.error(`Avisos del saldo: fallo al pedir ponerse al día: ${(err as Error).message}`);
      }
    }
  }
}

/** Una URL rara no tumba el arranque: se queda sin escuchar (y lo dice). */
function safeConnectionString(raw: string): string | null {
  try {
    return listenerConnectionString(raw);
  } catch {
    new Logger(WalletEventsListener.name).warn('Avisos del saldo: la URL de la base no se entiende; sin avisos (queda el sondeo)');
    return null;
  }
}

/** Cierra sin esperar a una conexión colgada ni dejar errores sueltos. */
async function closeQuietly(client: ListenClient): Promise<void> {
  client.removeAllListeners();
  client.on('error', () => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.end(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Ya estaba cerrada.
  } finally {
    clearTimeout(timer);
  }
}
