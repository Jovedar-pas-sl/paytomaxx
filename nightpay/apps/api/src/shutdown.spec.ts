import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server as IoServer } from 'socket.io';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { WorkerHost } from '@nestjs/bullmq';
import { PrismaService } from './common/prisma/prisma.service';
import { RedisModule } from './common/redis/redis.module';
import { disconnectSocketIo, gracefulShutdown, nestShutdownSteps, type ShutdownSteps } from './shutdown';

/**
 * Apagado (SIGTERM de Docker en cada despliegue start-first, DI-01). Antes,
 * enableShutdownHooks: Nest cerraba Prisma y Redis (onModuleDestroy) ANTES de
 * cerrar el servidor HTTP, y los workers de BullMQ los últimos: una petición o
 * un trabajo en vuelo se quedaban sin base o sin Redis. Ahora: dejar de
 * aceptar → terminar lo que está en vuelo (con tope) → parar los workers →
 * cerrar Prisma y Redis.
 */

const logger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('gracefulShutdown — el orden y los topes', () => {
  function steps(order: string[], o: { httpMs?: number; workersMs?: number; workersError?: Error } = {}): ShutdownSteps {
    return {
      stopAccepting: async () => {
        order.push('http:start');
        await sleep(o.httpMs ?? 0);
        order.push('http:done');
      },
      forceCloseHttp: () => void order.push('http:forced'),
      closeWorkers: async () => {
        order.push('workers:start');
        await sleep(o.workersMs ?? 0);
        if (o.workersError) throw o.workersError;
        order.push('workers:done');
      },
      closeApp: async () => void order.push('app'),
    };
  }

  it('HTTP → workers → el resto (Prisma, Redis), cada paso cuando termina el anterior', async () => {
    const order: string[] = [];
    await gracefulShutdown(steps(order, { httpMs: 20, workersMs: 20 }), logger(), { httpDrainMs: 1_000, workersDrainMs: 1_000 });
    expect(order).toEqual(['http:start', 'http:done', 'workers:start', 'workers:done', 'app']);
  });

  it('una petición que no termina en el tope se corta y se sigue', async () => {
    const order: string[] = [];
    const log = logger();
    await gracefulShutdown(steps(order, { httpMs: 200 }), log, { httpDrainMs: 30, workersDrainMs: 1_000 });
    expect(order.slice(0, 2)).toEqual(['http:start', 'http:forced']);
    expect(order.indexOf('workers:start')).toBeGreaterThan(order.indexOf('http:forced'));
    expect(order.at(-1)).toBe('app');
    expect(String(log.warn.mock.calls[0]![0])).toMatch(/30 ms/);
  });

  it('un trabajo que no termina en su tope no impide cerrar (BullMQ lo retoma en la otra réplica)', async () => {
    const order: string[] = [];
    const log = logger();
    await gracefulShutdown(steps(order, { workersMs: 200 }), log, { httpDrainMs: 1_000, workersDrainMs: 30 });
    expect(order.at(-1)).toBe('app');
    expect(order).not.toContain('workers:done');
    expect(log.warn).toHaveBeenCalled();
  });

  it('un error en un paso se registra y el apagado sigue', async () => {
    const order: string[] = [];
    const log = logger();
    await gracefulShutdown(steps(order, { workersError: new Error('Connection is closed') }), log, {
      httpDrainMs: 1_000,
      workersDrainMs: 1_000,
    });
    expect(order.at(-1)).toBe('app');
    expect(String(log.error.mock.calls[0]![0])).toContain('Connection is closed');
  });
});

describe('Prisma y Redis se cierran al final (onApplicationShutdown), no antes del HTTP (onModuleDestroy)', () => {
  it('PrismaService', () => {
    expect(PrismaService.prototype).not.toHaveProperty('onModuleDestroy');
    expect(typeof PrismaService.prototype.onApplicationShutdown).toBe('function');
  });

  it('RedisModule', () => {
    expect(RedisModule.prototype).not.toHaveProperty('onModuleDestroy');
    expect(typeof RedisModule.prototype.onApplicationShutdown).toBe('function');
  });
});

/* ── Con un Nest + Fastify de verdad (las mismas opciones que main.ts) ── */

const events: string[] = [];

/** La «base de datos»: global como PrismaModule, se cierra al final como Prisma. */
@Injectable()
class FakeDb implements OnApplicationShutdown {
  closed = false;
  async query(what: string): Promise<string> {
    if (this.closed) throw new Error('base cerrada');
    events.push(`db:${what}`);
    return 'ok';
  }
  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    events.push('db:closed');
  }
}

@Global()
@Module({ providers: [FakeDb], exports: [FakeDb] })
class FakeDbModule {}

/** Un worker de BullMQ con un trabajo a medias que usa la base al terminar. */
@Injectable()
class SlowJobWorker extends WorkerHost {
  constructor(@Inject(FakeDb) private readonly db: FakeDb) {
    super();
    let running: Promise<void> | null = null;
    const fakeWorker = {
      start: () => {
        // Termina después que la petición: al parar los workers aún está a medias.
        running = sleep(400).then(async () => {
          await this.db.query('job');
          events.push('job:done');
        });
      },
      close: vi.fn(async () => {
        events.push('workers:closing');
        await running;
      }),
    };
    Object.assign(this, { _worker: fakeWorker });
  }
  async process(): Promise<void> {}
  get fake(): { start: () => void; close: () => Promise<void> } {
    return (this as unknown as { _worker: { start: () => void; close: () => Promise<void> } })._worker;
  }
}

@Controller()
class SlowController {
  constructor(@Inject(FakeDb) private readonly db: FakeDb) {}
  @Get('slow')
  async slow(): Promise<{ ok: string }> {
    await sleep(200);
    return { ok: await this.db.query('request') };
  }
}

@Module({ imports: [FakeDbModule], controllers: [SlowController], providers: [SlowJobWorker] })
class ShutdownTestModule {}

/** Como era Prisma: se desconecta en onModuleDestroy (lo primero de app.close()). */
@Injectable()
class EarlyClosingDb extends FakeDb implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    events.push('db:closed');
  }
  override async onApplicationShutdown(): Promise<void> {}
}

@Global()
@Module({ providers: [EarlyClosingDb, { provide: FakeDb, useExisting: EarlyClosingDb }], exports: [FakeDb] })
class EarlyClosingDbModule {}

@Module({ imports: [EarlyClosingDbModule], controllers: [SlowController] })
class BeforeFixModule {}

@WebSocketGateway()
class TestGateway {
  @WebSocketServer()
  server!: IoServer;
}

@Module({ imports: [FakeDbModule], controllers: [SlowController], providers: [TestGateway] })
class RealtimeTestModule {}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res: IncomingMessage) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startApp(module: unknown, opts: { realtime?: boolean } = {}): Promise<{ app: NestFastifyApplication; port: number }> {
  const app = await NestFactory.create<NestFastifyApplication>(
    module as never,
    new FastifyAdapter({ return503OnClosing: true, forceCloseConnections: 'idle' }),
    { logger: false },
  );
  if (opts.realtime) app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, port: (app.getHttpServer().address() as AddressInfo).port };
}

describe('apagado de una app Nest + Fastify de verdad', () => {
  it('ANTES (enableShutdownHooks = app.close() con Prisma en onModuleDestroy): la petición en vuelo se quedaba sin base', async () => {
    const { app, port } = await startApp(BeforeFixModule);
    const inFlight = get(port, '/slow');
    await sleep(50);
    await app.close();
    const res = await inFlight;
    expect(res.status).toBe(500);
    expect(events).toEqual(['db:closed']);
  });

  it('una conexión de tiempo real abierta (socket.io) no deja el apagado esperando hasta el tope', async () => {
    const { app, port } = await startApp(RealtimeTestModule, { realtime: true });
    // Handshake de engine.io por «polling» y una espera larga abierta (como las apps).
    const hello = await get(port, '/socket.io/?EIO=4&transport=polling');
    const sid = (JSON.parse(hello.body.slice(1)) as { sid: string }).sid;
    const longPoll = get(port, `/socket.io/?EIO=4&transport=polling&sid=${sid}`).catch(() => null);
    await sleep(50);
    const io = app.get(TestGateway).server;
    const started = Date.now();
    const log = logger();
    await gracefulShutdown(nestShutdownSteps(app, () => disconnectSocketIo(io)), log, { httpDrainMs: 5_000, workersDrainMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(log.warn).not.toHaveBeenCalled();
    await longPoll;
  });

  let app: NestFastifyApplication | null = null;
  afterEach(async () => {
    events.length = 0;
    app = null;
  });

  it('la petición en vuelo termina (con la base abierta), el trabajo a medias también, y la base se cierra después', async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      ShutdownTestModule,
      new FastifyAdapter({ return503OnClosing: true, forceCloseConnections: 'idle' }),
      { logger: false },
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.getHttpServer().address() as AddressInfo).port;
    app.get(SlowJobWorker).fake.start();

    const inFlight = get(port, '/slow');
    await sleep(50); // la petición ya está dentro
    const log = logger();
    const done = gracefulShutdown(nestShutdownSteps(app), log, { httpDrainMs: 2_000, workersDrainMs: 2_000 });

    await expect(inFlight).resolves.toEqual({ status: 200, body: JSON.stringify({ ok: 'ok' }) });
    await done;
    // Lo nuevo ya no entra: el servidor no acepta conexiones.
    await expect(get(port, '/slow')).rejects.toThrow();

    expect(events.indexOf('db:request')).toBeGreaterThan(-1);
    expect(events.indexOf('db:job')).toBeGreaterThan(-1);
    expect(events.indexOf('job:done')).toBeLessThan(events.indexOf('db:closed'));
    expect(events.indexOf('db:request')).toBeLessThan(events.indexOf('db:closed'));
    // Primero se dejó de aceptar y terminó la petición; después se pararon los workers (esperando al trabajo).
    expect(events.indexOf('db:request')).toBeLessThan(events.indexOf('workers:closing'));
    expect(events.indexOf('workers:closing')).toBeLessThan(events.indexOf('job:done'));
    expect(events.indexOf('workers:closing')).toBeLessThan(events.indexOf('db:closed'));
    expect(events.at(-1)).toBe('db:closed');
    expect(log.error).not.toHaveBeenCalled();
  });
});
