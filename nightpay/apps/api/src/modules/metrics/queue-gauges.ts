import { Gauge, type Registry } from 'prom-client';
import type { Queue } from 'bullmq';
import { SCRAPE_TIMEOUT_MS, withTimeout } from './scrape-timeout';

/** Trabajos sin terminar: los que esperan, corren, están programados o esperan a sus hijos. */
const PENDING_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused'] as const;
/**
 * Los que ya podrían correr (o corren): su edad dice si los workers avanzan.
 * Los programados (delayed) y los que esperan a sus hijos no cuentan.
 */
const READY_STATES = ['waiting', 'active', 'prioritized', 'paused'] as const;
const QUEUE_STATES = [...PENDING_STATES, 'failed', 'completed'] as const;
/**
 * Trabajos leídos de la cabeza de cada estado (los próximos en salir, los más
 * antiguos de la lista) en cada scrape. Una sola lectura acotada: con 100.000
 * en cola cuesta lo mismo que con 10, y la métrica no desaparece justo cuando
 * hay atasco.
 */
export const QUEUE_HEAD_SAMPLE = 50;

/** Lo que se usa de una cola de BullMQ (las conexiones son suyas: aquí no se cierran). */
export type QueueSource = Pick<Queue, 'name' | 'getJobCounts'> & {
  getJobs: (...args: Parameters<Queue['getJobs']>) => Promise<Array<{ timestamp: number } | undefined>>;
};

/**
 * Las colas de BullMQ en /metrics, leídas en cada scrape: cuántos trabajos
 * hay por estado, cuántos sin terminar y la edad (desde que se creó) del más
 * antiguo de los que ya podrían correr. Si Redis no contesta a tiempo, esa
 * cola se queda sin muestras y con _up a 0 (no se enseña un valor viejo).
 */
export class QueueGauges {
  readonly depth: Gauge;
  readonly jobs: Gauge;
  readonly oldestAge: Gauge;
  readonly up: Gauge;
  private readonly sources = new Set<QueueSource>();

  constructor(registry: Registry) {
    this.depth = new Gauge({
      name: 'nightpay_queue_depth',
      help: 'Trabajos sin terminar en BullMQ (waiting, active, delayed, prioritized, waiting-children, paused)',
      labelNames: ['queue'],
      registers: [registry],
    });
    this.jobs = new Gauge({ name: 'nightpay_queue_jobs', help: 'Trabajos BullMQ por estado', labelNames: ['queue', 'state'], registers: [registry] });
    this.oldestAge = new Gauge({
      name: 'nightpay_queue_oldest_age_seconds',
      help: 'Segundos desde la creación del trabajo más antiguo de la cabeza de waiting/active/prioritized/paused (no delayed ni waiting-children)',
      labelNames: ['queue'],
      registers: [registry],
    });
    this.up = new Gauge({
      name: 'nightpay_queue_metrics_up',
      help: '1 si se pudo consultar BullMQ en este scrape, 0 si falló',
      labelNames: ['queue'],
      registers: [registry],
    });
  }

  /** Empieza a medir estas colas. Devuelve cómo dejar de medirlas (antes de que BullMQ cierre). */
  observe(queues: readonly QueueSource[]): () => void {
    queues.forEach((queue) => this.sources.add(queue));
    return () =>
      queues.forEach((queue) => {
        this.sources.delete(queue);
        this.clear(queue.name);
        this.up.remove({ queue: queue.name });
      });
  }

  /** Lee todas las colas (cada una por su lado: una que falla no tapa a las demás). */
  async collect(): Promise<void> {
    await Promise.all([...this.sources].map((queue) => this.collectOne(queue)));
  }

  private async collectOne(queue: QueueSource): Promise<void> {
    try {
      const [counts, age] = await withTimeout(
        Promise.all([queue.getJobCounts(...QUEUE_STATES), this.headAge(queue)]),
        SCRAPE_TIMEOUT_MS,
        'BullMQ metrics timeout',
      );
      if (!this.sources.has(queue)) return;
      const labels = { queue: queue.name };
      QUEUE_STATES.forEach((state) => this.jobs.set({ ...labels, state }, counts[state] ?? 0));
      this.depth.set(labels, PENDING_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0));
      this.oldestAge.set(labels, age);
      this.up.set(labels, 1);
    } catch {
      if (!this.sources.has(queue)) return;
      this.clear(queue.name);
      this.up.set({ queue: queue.name }, 0);
    }
  }

  /**
   * Edad del más antiguo de la cabeza de cada estado listo (asc: primero los
   * más antiguos de cada lista). Un trabajo que ya terminó entre leer su id y
   * sus datos llega como undefined y no cuenta.
   */
  private async headAge(queue: QueueSource): Promise<number> {
    const jobs = await queue.getJobs([...READY_STATES], 0, QUEUE_HEAD_SAMPLE - 1, true);
    const now = Date.now();
    return jobs.reduce((oldest, job) => (job ? Math.max(oldest, (now - job.timestamp) / 1000) : oldest), 0);
  }

  private clear(queue: string): void {
    this.depth.remove({ queue });
    this.oldestAge.remove({ queue });
    QUEUE_STATES.forEach((state) => this.jobs.remove({ queue, state }));
  }
}
