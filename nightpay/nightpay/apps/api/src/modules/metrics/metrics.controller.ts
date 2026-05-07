import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * GET /v1/metrics — formato Prometheus text exposition.
 * Publico (sin auth) — pero deberias proteger via Cloudflare Access o IP allowlist
 * en produccion. En dev expuesto sin restriccion para integracion con Grafana free.
 */
@Controller('metrics')
export class MetricsController {
  private readonly metrics: MetricsService;
  constructor(@Inject(MetricsService) metrics: MetricsService) {
    this.metrics = metrics;
  }

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(@Res() res: FastifyReply): Promise<void> {
    const body = await this.metrics.render();
    res.send(body);
  }
}
