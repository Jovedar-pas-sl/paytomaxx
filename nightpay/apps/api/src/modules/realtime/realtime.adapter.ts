import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { ServerOptions } from 'socket.io';

type RedisFactory = (url: string) => Redis;

const defaultRedis: RedisFactory = (url) => new Redis(url, { lazyConnect: false });

/**
 * Adaptador Socket.io que mete pub/sub via Redis (ADR-001).
 * Permite que multiples instancias del API compartan eventos —
 * critico cuando escalemos a >1 nodo tras balanceador.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private readonly adapterConstructor: ReturnType<typeof createAdapter>;
  private readonly pubClient: Redis;
  private readonly subClient: Redis;

  constructor(app: INestApplicationContext, createRedis: RedisFactory = defaultRedis) {
    super(app);
    const config = app.get(ConfigService);
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    // ioredis acepta URL directamente — parsea password, db, host, port
    this.pubClient = createRedis(redisUrl);
    this.subClient = this.pubClient.duplicate();

    this.pubClient.on('error', (err) => this.logger.error(`pub redis: ${err.message}`));
    this.subClient.on('error', (err) => this.logger.error(`sub redis: ${err.message}`));

    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    const url = new URL(redisUrl);
    this.logger.log(`Socket.io Redis adapter wired -> ${url.hostname}:${url.port}`);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: true, credentials: true },
      transports: ['websocket', 'polling'],
    });
    (server as any).adapter(this.adapterConstructor);
    return server;
  }

  /** Al cerrar la app (después de cerrar los servidores): fuera las conexiones pub/sub. */
  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.all([closeRedis(this.pubClient), closeRedis(this.subClient)]);
  }
}

async function closeRedis(client: Pick<Redis, 'quit' | 'disconnect'>): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
