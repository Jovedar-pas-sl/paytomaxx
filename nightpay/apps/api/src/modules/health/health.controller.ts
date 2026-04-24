import { Controller, Get } from '@nestjs/common';
import type { Health } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  get(): Health {
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.0.0',
      timestamp: new Date().toISOString(),
      checks: {
        api: 'ok',
        db: 'skip',
        redis: 'skip',
      },
    };
  }
}
