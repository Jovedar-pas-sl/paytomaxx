import { Worker } from 'node:worker_threads';

/**
 * bcrypt de las contraseñas del personal en otro hilo. bcryptjs es JS puro:
 * ~80 ms de CPU por contraseña (coste 10) en el hilo del API, y su versión
 * «asíncrona» lo hace en trozos de hasta 100 ms. Con 21 entradas al turno a la
 * vez todo el API se paraba (carga del 19-11-2026: login 3 s de mediana).
 * Mismo bcryptjs y mismos hashes ($2a$/$2b$): los de la base siguen valiendo.
 */

/** Hilos a la vez: el API sigue en el suyo; más hilos que núcleos no aceleran nada. */
const POOL_SIZE = 2;

// El hilo: carga bcryptjs por su ruta (la del API, sea cual sea la carpeta de trabajo) y contesta cada encargo.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.on('message', (job) => {
  try {
    const value = job.op === 'hash' ? bcrypt.hashSync(job.plain, job.rounds) : bcrypt.compareSync(job.plain, job.hash);
    parentPort.postMessage({ id: job.id, value });
  } catch (err) {
    parentPort.postMessage({ id: job.id, error: err instanceof Error ? err.message : 'bcrypt' });
  }
});
`;

type Job = { op: 'hash'; plain: string; rounds: number } | { op: 'compare'; plain: string; hash: string };
interface Slot {
  worker: Worker;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
}

const slots: Array<Slot | undefined> = [];
let seq = 0;

function slotAt(i: number): Slot {
  const existing = slots[i];
  if (existing) return existing;
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { bcryptPath: require.resolve('bcryptjs') } });
  const slot: Slot = { worker, pending: new Map() };
  worker.unref(); // sin encargos, no retiene el proceso
  worker.on('message', (msg: { id: number; value?: unknown; error?: string }) => {
    const job = slot.pending.get(msg.id);
    slot.pending.delete(msg.id);
    if (slot.pending.size === 0) worker.unref();
    if (msg.error !== undefined) job?.reject(new Error(msg.error));
    else job?.resolve(msg.value);
  });
  // El hilo se cae: lo que tenía falla (el login da 500, como antes un error de bcrypt) y el siguiente encargo abre otro.
  const lost = (err: Error) => {
    if (slots[i] === slot) slots[i] = undefined;
    for (const job of slot.pending.values()) job.reject(err);
    slot.pending.clear();
  };
  worker.on('error', lost);
  worker.on('exit', (code) => lost(new Error(`hilo de contraseñas terminado (${code})`)));
  slots[i] = slot;
  return slot;
}

function run<T>(job: Job): Promise<T> {
  const id = (seq += 1);
  const slot = slotAt(id % POOL_SIZE);
  return new Promise<T>((resolve, reject) => {
    slot.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    slot.worker.ref(); // con encargos, el proceso espera su respuesta
    slot.worker.postMessage({ id, ...job });
  });
}

/** Hash bcrypt nuevo (como bcrypt.hash), calculado en otro hilo. */
export function bcryptHash(plain: string, rounds: number): Promise<string> {
  return run<string>({ op: 'hash', plain, rounds });
}

/** ¿Es esta la contraseña? (como bcrypt.compare), calculado en otro hilo. */
export function bcryptCompare(plain: string, hash: string): Promise<boolean> {
  return run<boolean>({ op: 'compare', plain, hash });
}

/** Cierra los hilos (pruebas). */
export async function stopPasswordWorkers(): Promise<void> {
  await Promise.all(slots.splice(0).map((slot) => slot?.worker.terminate()));
}
