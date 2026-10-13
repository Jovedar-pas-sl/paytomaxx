import { Controller, Get, Header, Inject, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { MetricsAccessGuard } from '../../common/guards/metrics-access.guard';
import { MetricsService } from './metrics.service';

/**
 * GET /v1/metrics — formato Prometheus text exposition.
 * Sin login de usuario, pero en producción solo para el scrape interno o con
 * METRICS_TOKEN (ver MetricsAccessGuard). En dev, abierto.
 */
@Controller('metrics')
@UseGuards(MetricsAccessGuard)
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
