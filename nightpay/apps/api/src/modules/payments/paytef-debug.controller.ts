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

  /**
   * Aplica el MISMO picker que paytef.adapter para diagnosticar qué branch
   * elige en runtime. Si esto devuelve algo distinto a lo que aparece en
   * "Branch not found" del error de /save, hay bug en el adapter.
   */
  @Public()
  @Get('picked')
  async picked(): Promise<unknown> {
    const raw = (await this.branches()) as { body?: { data?: unknown[] } };
    const branches = (raw.body?.data ?? []) as Array<{
      companyID?: number;
      branchID?: number;
      branchName?: string;
      displayName?: string;
    }>;
    const branchNameOf = (b: typeof branches[number]): string =>
      (b.branchName ?? b.displayName ?? '').trim();
    const isCleanName = (s: string): boolean =>
      Boolean(s && /^[A-Za-z0-9_]+$/.test(s) && !s.endsWith('-'));
    const preferredName = this.config.get<string>('PAYTEF_BRANCH_NAME');
    let chosen: typeof branches[number] | undefined;
    if (preferredName) {
      const want = preferredName.trim().toLowerCase();
      chosen = branches.find((b) => branchNameOf(b).toLowerCase() === want);
    }
    if (!chosen) {
      chosen = branches.find((b) => isCleanName(branchNameOf(b)));
    }
    if (!chosen) {
      chosen = branches[branches.length - 1] ?? branches[0];
    }
    return {
      total: branches.length,
      preferredName: preferredName ?? null,
      chosen,
      pickerWouldSend: {
        companyID: chosen?.companyID,
        branchID: chosen?.branchID,
      },
      allBranches: branches.map((b) => ({
        branchID: b.branchID,
        branchName: b.branchName,
        clean: isCleanName(branchNameOf(b)),
      })),
    };
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
