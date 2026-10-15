import { describe, it, expect } from 'vitest';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
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
