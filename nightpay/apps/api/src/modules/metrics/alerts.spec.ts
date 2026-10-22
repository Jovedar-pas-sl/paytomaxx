import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rules = readFileSync(resolve(__dirname, '../../../../../docs/observability/alerts.yml'), 'utf8').replace(/\r\n/g, '\n');
function expression(alert: string): string {
  const block = rules.split(`- alert: ${alert}\n`)[1]?.split(/\n\s+- alert:/)[0] ?? '';
  return block.match(/expr:\s*\|?\s*([\s\S]*?)\n\s+for:/)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('Prometheus alert contracts (promtool fixtures provide full evaluation)', () => {
  it('alerts on the original age of deferred earning reversals and failed collection', () => {
    expect(expression('EarningReversalOldest')).toBe('nightpay_earning_reversal_oldest_age_seconds > 1800');
    expect(expression('EarningReversalMetricsUnavailable')).toBe('nightpay_earning_reversal_metrics_up == 0');
  });
  it('aggregates incompatible payment labels by scrape job and guards a zero denominator', () => {
    const expr = expression('HighErrorRate');
    expect(expr).toContain('sum by (job) (rate(nightpay_payments_transitioned_total{to="FAILED"}[5m]))');
    expect(expr).toContain('sum by (job) (rate(nightpay_payments_created_total[5m]))');
    expect(expr).toContain('and on (job)');
    expect(expr).toMatch(/nightpay_payments_created_total\[5m\]\)\) > 0/);
  });

  it('uses live queue depth, age and collection status instead of unrelated payment timestamps', () => {
    expect(expression('QueueBacklog')).toBe('nightpay_queue_depth > 1000');
    expect(expression('QueueOldestJob')).toContain('nightpay_queue_oldest_age_seconds > 600');
    expect(expression('QueueMetricsUnavailable')).toBe('nightpay_queue_metrics_up == 0');
    expect(rules).not.toContain('last_over_time(timestamp(rate(nightpay_payments_transitioned_total');
  });
});
