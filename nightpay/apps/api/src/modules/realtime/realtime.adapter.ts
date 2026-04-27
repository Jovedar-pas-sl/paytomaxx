import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { ServerOptions } from 'socket.io';

/**
 * Adaptador Socket.io que mete pub/sub via Redis (ADR-001).
 * Permite que multiples instancias del API compartan eventos —
 * critico cuando escalemos a >1 nodo tras balanceador.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
    const config = app.get(ConfigService);
    const url = new URL(config.getOrThrow<string>('REDIS_URL'));
    const opts = {
      host: url.hostname,
      port: Number(url.port || 6379),
      lazyConnect: false,
    };
    const pubClient = new Redis(opts);
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => this.logger.error(`pub redis: ${err.message}`));
    subClient.on('error', (err) => this.logger.error(`sub redis: ${err.message}`));

    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log(`Socket.io Redis adapter wired -> ${url.hostname}:${url.port}`);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: true, credentials: true },
      transports: ['websocket', 'polling'],
    });
    if (this.adapterConstructor) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).adapter(this.adapterConstructor);
    }
    return server;
  }
}
