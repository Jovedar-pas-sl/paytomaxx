import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';

/**
 * TEMP DIAG controller. Llama directamente a Paytef /getBranches y devuelve
 * la respuesta cruda. Sin auth porque el usuario no puede pegar tokens en
 * Dokploy logs. Borrar después de descifrar el shape de Paytef.
 */
@Controller('debug/paytef')
export class PaytefDebugController {
  private readonly logger = new Logger(PaytefDebugController.name);
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  @Public()
  @Get('branches')
  async branches(): Promise<unknown> {
    const baseUrl = this.config.get<string>('PAYTEF_API_URL') ?? 'https://api.paytef.es/gcf';
    const token = this.config.get<string>('PAYTEF_API_TOKEN');
    if (!token) {
      return { error: 'PAYTEF_API_TOKEN not configured' };
    }
    const authHeader = token.trim().startsWith('PAYTEF-TOKEN ')
      ? token.trim()
      : `PAYTEF-TOKEN ${token.trim()}`;
    try {
      const res = await fetch(`${baseUrl}/payment-link/getBranches`, {
        method: 'GET',
        headers: { Authorization: authHeader },
      });
      const status = res.status;
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      let body: unknown = null;
      let bodyText: string | null = null;
      try {
        body = await res.json();
      } catch {
        bodyText = await res.text().catch(() => null);
      }
      return { status, headers, body, bodyText };
    } catch (e) {
      this.logger.error(`debug/paytef/branches failed: ${(e as Error).message}`);
      return { error: (e as Error).message };
    }
  }
}
