import { describe, it, expect, vi } from 'vitest';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('descuentos por devolución: todo lo pendiente, su antigüedad y lo que necesita a una persona; sin consulta, sin muestras', async () => {
    const metrics = new MetricsService();
    const query = vi.fn().mockResolvedValue({ pending: 101, oldestAgeSeconds: 10800, needsHuman: 2 });
    metrics.observeEarningReversals(query);
    const text = await metrics.render();
    expect(text).toContain('nightpay_earning_reversal_pending 101');
    expect(text).toContain('nightpay_earning_reversal_oldest_age_seconds 10800');
    expect(text).toContain('nightpay_earning_reversal_needs_human 2');
    expect(text).toContain('nightpay_earning_reversal_metrics_up 1');
    query.mockRejectedValueOnce(new Error('db unavailable'));
    const failed = await metrics.render();
    expect(failed).toContain('nightpay_earning_reversal_metrics_up 0');
    // Ni 0 ni el valor de antes: un 0 diría «nada pendiente».
    for (const name of ['pending', 'oldest_age_seconds', 'needs_human']) {
      expect(failed).not.toMatch(new RegExp(`^nightpay_earning_reversal_${name} `, 'm'));
    }
  });

  it('earningReversalFailed solo por local: el id del cobro no es etiqueta (cardinalidad sin límite)', async () => {
    const metrics = new MetricsService();
    // Quien aún pase payment_id no rompe (antes era etiqueta).
    metrics.earningReversalFailed.inc({ venue: 'v-1', payment_id: '7d0f4f9e-0000-4000-8000-000000000001' });
    metrics.earningReversalFailed.inc({ venue: 'v-1' });
    const text = await metrics.render();
    expect(text).toContain('nightpay_earning_reversal_failed_total{venue="v-1"} 2');
    expect(text).not.toContain('payment_id');
  });
});
