import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MetricsService } from './metrics.service';

/**
 * Contrato entre las reglas de docs/observability/alerts.yml y lo que exporta
 * el API. La evaluación de verdad (disparar, no repetirse por réplica y
 * resolverse) la hace promtool en CI con alerts.test.yml.
 */
const rules = readFileSync(resolve(__dirname, '../../../../../docs/observability/alerts.yml'), 'utf8').replace(/\r\n/g, '\n');
function expression(alert: string): string {
  const block = rules.split(`- alert: ${alert}\n`)[1]?.split(/\n\s+- alert:/)[0] ?? '';
  return block.match(/expr:\s*\|?\s*([\s\S]*?)\n\s+for:/)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('reglas de alertas de Prometheus', () => {
  it('descuentos por devolución: antigüedad desde la devolución, lo que necesita a una persona y la consulta caída', () => {
    expect(expression('EarningReversalOldest')).toBe('max by (job) (nightpay_earning_reversal_oldest_age_seconds) > 1800');
    expect(expression('EarningReversalNeedsHuman')).toBe('max by (job) (nightpay_earning_reversal_needs_human) > 0');
    expect(expression('EarningReversalMetricsUnavailable')).toBe('nightpay_earning_reversal_metrics_up == 0');
  });

  it('tasa de fallos: suma por job antes de dividir (etiquetas distintas) y no divide entre cero', () => {
    const expr = expression('HighErrorRate');
    expect(expr).toContain('sum by (job) (rate(nightpay_payments_transitioned_total{to="FAILED"}[5m]))');
    expect(expr).toContain('sum by (job) (rate(nightpay_payments_created_total[5m]))');
    expect(expr).toContain('and on (job)');
    expect(expr).toMatch(/nightpay_payments_created_total\[5m\]\)\) > 0/);
  });

  it('colas: backlog, edad y fallidos de verdad, una alerta por cola aunque haya varias réplicas', () => {
    expect(expression('QueueBacklog')).toBe('max by (job, queue) (nightpay_queue_depth) > 1000');
    expect(expression('QueueOldestJob')).toBe('max by (job, queue) (nightpay_queue_oldest_age_seconds) > 600');
    expect(expression('QueueFailedJobs')).toBe('max by (job, queue) (nightpay_queue_jobs{state="failed"}) > 0');
    expect(expression('QueueMetricsUnavailable')).toBe('nightpay_queue_metrics_up == 0');
    expect(rules).not.toContain('last_over_time(timestamp(rate(nightpay_payments_transitioned_total');
  });

  it('cada métrica nightpay_ que usan las reglas la exporta el API', async () => {
    const metrics = new MetricsService();
    metrics.observeQueues([{ name: 'q', getJobCounts: async () => ({ failed: 1 }), getJobs: async () => [] }]);
    metrics.observeEarningReversals(async () => ({ pending: 1, oldestAgeSeconds: 1, needsHuman: 0 }));
    const exported = await metrics.render();
    const used = [...new Set(rules.match(/nightpay_[a-z_]+/g) ?? [])];
    expect(used.length).toBeGreaterThan(5);
    for (const name of used) expect(exported, name).toMatch(new RegExp(`^# TYPE ${name}(?:_total)? `, 'm'));
  });
});
