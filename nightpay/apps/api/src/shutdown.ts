import type { Server } from 'node:http';
import type { LoggerService } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { WorkerHost } from '@nestjs/bullmq';

/**
 * Apagado ordenado del API (SIGTERM de Docker en cada despliegue start-first).
 *
 * Con app.enableShutdownHooks() Nest hace: onModuleDestroy (Prisma $disconnect,
 * Redis quit) → cerrar el HTTP → onApplicationShutdown (workers de BullMQ):
 * una petición de cobro, un aviso del banco o un trabajo en vuelo se quedaban
 * sin base o sin Redis. Aquí, en este orden:
 *   1. dejar de aceptar: el servidor no coge conexiones nuevas, contesta 503 a
 *      lo que llegue por las abiertas y espera a lo que está en vuelo (con
 *      tope: pasado, se cortan las conexiones que queden);
 *   2. parar los workers de BullMQ: terminan el trabajo que tienen entre manos
 *      y no cogen más (con tope: uno que no termina, BullMQ lo retoma en la
 *      otra réplica al vencer su candado);
 *   3. app.close(): temporizadores (onModuleDestroy), colas y, al final,
 *      Prisma y Redis (onApplicationShutdown de sus módulos globales).
 */

/** Tope para las peticiones en vuelo (las de la pasarela tienen sus propios tiempos). */
export const HTTP_DRAIN_MS = 10_000;
/** Tope para el trabajo en curso de los workers. */
export const WORKERS_DRAIN_MS = 10_000;
/** Todo el apagado, por debajo del stop grace de Docker (30 s): pasado, se sale igual. */
export const SHUTDOWN_DEADLINE_MS = 27_000;

export interface ShutdownSteps {
  /** Deja de aceptar y espera a lo que está en vuelo. */
  stopAccepting(): Promise<void>;
  /** Corta las conexiones que siguen abiertas pasado el tope. */
  forceCloseHttp(): void;
  /** Los workers de BullMQ terminan su trabajo y no cogen más. */
  closeWorkers(): Promise<void>;
  /** El resto del apagado de Nest (temporizadores, colas, Prisma, Redis). */
  closeApp(): Promise<void>;
}

type ShutdownLogger = Pick<LoggerService, 'log' | 'warn' | 'error'>;

/** true si `work` terminó antes de `ms`; un error se registra y cuenta como terminado. */
async function within(work: Promise<void>, ms: number, what: string, logger: ShutdownLogger): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        (err: unknown) => {
          logger.error(`Apagado: fallo al ${what}: ${(err as Error)?.message ?? String(err)}`);
          return true;
        },
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function gracefulShutdown(
  steps: ShutdownSteps,
  logger: ShutdownLogger,
  limits: { httpDrainMs: number; workersDrainMs: number } = { httpDrainMs: HTTP_DRAIN_MS, workersDrainMs: WORKERS_DRAIN_MS },
): Promise<void> {
  logger.log('Apagando: no se aceptan peticiones nuevas; se terminan las que están en vuelo');
  if (!(await within(steps.stopAccepting(), limits.httpDrainMs, 'cerrar el servidor HTTP', logger))) {
    logger.warn(`Apagado: peticiones aún en vuelo tras ${limits.httpDrainMs} ms: se cortan`);
    steps.forceCloseHttp();
  }
  if (!(await within(steps.closeWorkers(), limits.workersDrainMs, 'parar los workers', logger))) {
    logger.warn(
      `Apagado: trabajos de las colas aún en curso tras ${limits.workersDrainMs} ms: se cierra igual (la otra réplica los retoma)`,
    );
  }
  try {
    await steps.closeApp();
  } catch (err) {
    logger.error(`Apagado: fallo al cerrar la aplicación: ${(err as Error)?.message ?? String(err)}`);
  }
  logger.log('Apagado terminado');
}

/** Los workers de BullMQ de la app (un @Processor por cola). */
function bullWorkers(app: NestFastifyApplication): Array<{ close(): Promise<void> }> {
  const workers: Array<{ close(): Promise<void> }> = [];
  for (const moduleRef of app.get(ModulesContainer).values()) {
    for (const wrapper of moduleRef.providers.values()) {
      const instance: unknown = wrapper.instance;
      if (!(instance instanceof WorkerHost)) continue;
      try {
        workers.push(instance.worker);
      } catch {
        // Sin worker (no llegó a registrarse): nada que parar.
      }
    }
  }
  return workers;
}

/**
 * Los pasos para una app Nest + Fastify. `disconnectRealtime` corta las
 * conexiones de tiempo real de esta réplica (socket.io): no terminan solas y
 * no dejarían cerrar el servidor; las apps reconectan solas, ya a la nueva.
 */
export function nestShutdownSteps(
  app: NestFastifyApplication,
  disconnectRealtime: () => void = () => {},
  logger?: ShutdownLogger,
): ShutdownSteps {
  return {
    stopAccepting: async () => {
      // Si falla (p. ej. el gateway sin iniciar), se cierra el HTTP igual.
      try {
        disconnectRealtime();
      } catch (err) {
        logger?.warn(`Apagado: no se pudo cortar el tiempo real: ${(err as Error)?.message ?? String(err)}`);
      }
      // Fastify: deja de aceptar conexiones, 503 a lo nuevo (return503OnClosing),
      // cierra las conexiones inactivas y espera a las que tienen una petición.
      await app.getHttpAdapter().close();
    },
    forceCloseHttp: () => (app.getHttpServer() as Server).closeAllConnections(),
    closeWorkers: async () => {
      await Promise.all(bullWorkers(app).map((w) => w.close()));
    },
    closeApp: () => app.close(),
  };
}

/**
 * Sustituye a app.enableShutdownHooks(): SIGTERM/SIGINT → gracefulShutdown y
 * salir (process.exit: el proceso es el PID 1 del contenedor y no muere solo
 * con la señal). Una segunda señal no vuelve a empezar.
 */
export function installGracefulShutdown(
  app: NestFastifyApplication,
  logger: ShutdownLogger,
  disconnectRealtime?: () => void,
): void {
  let started = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (started) return;
    started = true;
    logger.log(`${signal} recibido`);
    const deadline = setTimeout(() => {
      logger.error(`Apagado sin terminar a los ${SHUTDOWN_DEADLINE_MS} ms: se sale igual`);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    gracefulShutdown(nestShutdownSteps(app, disconnectRealtime, logger), logger).then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error(`Apagado con error: ${(err as Error)?.message ?? String(err)}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

/** Lo que hace falta del `server` de un gateway: el Server de socket.io o, con `namespace`, su Namespace. */
export interface SocketIoLike {
  local: { disconnectSockets(close?: boolean): void };
  /** Server raíz: su engine.io. */
  engine?: { close(): unknown };
  /** Namespace (`@WebSocketGateway({ namespace: '/rt' })`, como el gateway de verdad): su Server raíz. */
  server?: { engine?: { close(): unknown } };
}

/**
 * Corta las conexiones de tiempo real de ESTA réplica (con el adaptador de
 * Redis, io.disconnectSockets() las cortaría en todas: también en la nueva).
 * engine.close() corta además las que aún no entraron en ningún espacio. El
 * gateway de verdad usa `namespace: '/rt'`: su `server` es un Namespace, sin
 * `.engine`; el engine.io es el de su Server raíz (`namespace.server`).
 */
export function disconnectSocketIo(io: SocketIoLike | undefined): void {
  if (!io) return;
  io.local.disconnectSockets(true);
  const engine = io.engine ?? io.server?.engine;
  if (!engine) throw new Error('el gateway de tiempo real no tiene engine.io (¿sin iniciar?)');
  engine.close();
}
