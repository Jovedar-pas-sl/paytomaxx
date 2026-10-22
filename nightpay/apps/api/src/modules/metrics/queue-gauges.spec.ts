import { describe, it, expect, vi, afterEach } from 'vitest';
import { MetricsService } from './metrics.service';
import { QUEUE_HEAD_SAMPLE } from './queue-gauges';

type Job = { timestamp: number } | undefined;

/** Una cola de BullMQ de mentira: recuentos por estado y la cabeza de cada estado listo. */
function queue(name: string, counts: Record<string, number>, head: Job[] = []) {
  return { name, getJobCounts: vi.fn().mockResolvedValue(counts), getJobs: vi.fn(async (): Promise<Job[]> => head) };
}
const ageOf = (text: string, name: string) =>
  Number(new RegExp(`nightpay_queue_oldest_age_seconds\\{queue="${name}"\\} ([0-9.]+)`).exec(text)?.[1]);

afterEach(() => vi.useRealTimers());

describe('colas de BullMQ en /metrics (las que de verdad hay)', () => {
  it('por estado; sin terminar = waiting+active+delayed+prioritized+waiting-children+paused (no failed ni completed)', async () => {
    const metrics = new MetricsService();
    const now = Date.now();
    const q = queue('webhooks-ingest', { waiting: 2, active: 1, delayed: 3, prioritized: 1, paused: 2, 'waiting-children': 4, failed: 7, completed: 20 }, [{ timestamp: now - 120_000 }]);
    metrics.observeQueues([q]);
    const text = await metrics.render();
    expect(text).toContain('nightpay_queue_depth{queue="webhooks-ingest"} 13');
    expect(text).toContain('nightpay_queue_jobs{queue="webhooks-ingest",state="failed"} 7');
    expect(text).toContain('nightpay_queue_jobs{queue="webhooks-ingest",state="completed"} 20');
    expect(text).toContain('nightpay_queue_metrics_up{queue="webhooks-ingest"} 1');
    expect(ageOf(text, 'webhooks-ingest')).toBeGreaterThanOrEqual(120);
    expect(q.getJobCounts).toHaveBeenCalledWith('waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused', 'failed', 'completed');
  });

  it('la edad: el más antiguo de la cabeza de los estados listos, en UNA lectura acotada aunque haya 100.000', async () => {
    const metrics = new MetricsService();
    const now = Date.now();
    const q = queue('atasco', { waiting: 100_000 }, [{ timestamp: now - 900_000 }, { timestamp: now - 899_000 }]);
    metrics.observeQueues([q]);
    const text = await metrics.render();
    expect(ageOf(text, 'atasco')).toBeGreaterThanOrEqual(900);
    expect(text).toContain('nightpay_queue_depth{queue="atasco"} 100000');
    expect(q.getJobs).toHaveBeenCalledTimes(1);
    // Los programados (delayed) y los que esperan a sus hijos no cuentan para la edad; asc = los más antiguos.
    expect(q.getJobs).toHaveBeenCalledWith(['waiting', 'active', 'prioritized', 'paused'], 0, QUEUE_HEAD_SAMPLE - 1, true);
  });

  it('cola vacía o un trabajo que terminó entre leer su id y sus datos: edad 0, sin error', async () => {
    const metrics = new MetricsService();
    metrics.observeQueues([queue('vacia', {}), queue('carrera', { active: 0 }, [undefined])]);
    const text = await metrics.render();
    expect(text).toContain('nightpay_queue_oldest_age_seconds{queue="vacia"} 0');
    expect(text).toContain('nightpay_queue_oldest_age_seconds{queue="carrera"} 0');
    expect(text).toContain('nightpay_queue_metrics_up{queue="carrera"} 1');
  });

  it('Redis falla: esa cola sin muestras viejas y _up a 0; las demás siguen; al volver, se recupera', async () => {
    const metrics = new MetricsService();
    const bad = queue('payments-lifecycle', { waiting: 5 });
    const good = queue('qr-expire', { delayed: 3 });
    metrics.observeQueues([bad, good]);
    expect(await metrics.render()).toContain('nightpay_queue_depth{queue="payments-lifecycle"} 5');
    bad.getJobCounts.mockRejectedValueOnce(new Error('Redis disconnected'));
    const down = await metrics.render();
    expect(down).toContain('nightpay_queue_metrics_up{queue="payments-lifecycle"} 0');
    expect(down).not.toContain('nightpay_queue_depth{queue="payments-lifecycle"}');
    expect(down).not.toContain('nightpay_queue_jobs{queue="payments-lifecycle"');
    expect(down).toContain('nightpay_queue_depth{queue="qr-expire"} 3');
    expect(await metrics.render()).toContain('nightpay_queue_metrics_up{queue="payments-lifecycle"} 1');
  });

  it('Redis no contesta en 2 s: no se queda colgado el scrape', async () => {
    vi.useFakeTimers();
    const metrics = new MetricsService();
    const stuck = { name: 'colgada', getJobCounts: vi.fn(() => new Promise<never>(() => undefined)), getJobs: vi.fn(async () => []) };
    metrics.observeQueues([stuck]);
    const scrape = metrics.render();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await scrape).toContain('nightpay_queue_metrics_up{queue="colgada"} 0');
  });

  it('dos scrapes a la vez leen Redis una sola vez', async () => {
    const metrics = new MetricsService();
    const q = queue('una', { waiting: 1 });
    metrics.observeQueues([q]);
    await Promise.all([metrics.render(), metrics.render()]);
    expect(q.getJobCounts).toHaveBeenCalledTimes(1);
  });

  it('al parar: se quitan sus muestras (también una lectura en curso) y no se cierran las conexiones de BullMQ', async () => {
    const metrics = new MetricsService();
    let resolve!: (counts: Record<string, number>) => void;
    const q = { name: 'test', getJobCounts: vi.fn().mockReturnValue(new Promise((r) => (resolve = r))), getJobs: vi.fn(async () => []), close: vi.fn() };
    const unregister = metrics.observeQueues([q]);
    const pending = metrics.render();
    unregister();
    resolve({ waiting: 9 });
    expect(await pending).not.toContain('nightpay_queue_depth{queue="test"}');
    await metrics.render();
    expect(q.getJobCounts).toHaveBeenCalledTimes(1);
    expect(q.close).not.toHaveBeenCalled();
  });
});
