import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Provider } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Pasarelas cuyos avisos solo se atienden si algún local las usa (Paytef y
 * Peanpe): sin una credencial activa de esa pasarela en ningún local, sus
 * rutas de aviso contestan 404 sin mirar nada (ni secreto, ni cuerpo, ni
 * Redis). Redsys y Wipay no pasan por aquí.
 */
export const GATED_WEBHOOK_PROVIDERS = ['PAYTEF', 'PEANPE'] as const satisfies readonly Provider[];
export type GatedWebhookProvider = (typeof GATED_WEBHOOK_PROVIDERS)[number];

/**
 * Cuánto vale la respuesta de la base: un aluvión de avisos falsos a una
 * pasarela apagada no hace una consulta por petición, y un local que empieza
 * a usarla la tiene abierta en como mucho este tiempo.
 */
export const WEBHOOK_GATE_TTL_MS = 30_000;

interface Snapshot {
  at: number;
  enabled: ReadonlySet<Provider>;
}

@Injectable()
export class WebhookProviderGate implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhookProviderGate.name);
  private readonly prisma: PrismaService;
  private snapshot: Snapshot | null = null;
  private inFlight: Promise<Snapshot> | null = null;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /** Al arrancar, una vez: qué avisos de pasarela están abiertos y cuáles contestan 404. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const { enabled } = await this.refresh();
      this.logger.log(bootLine(enabled));
    } catch (err) {
      this.logger.warn(`No se pudo ver qué pasarelas usan los locales al arrancar: ${(err as Error).message}`);
    }
  }

  /** ¿Algún local tiene una credencial activa de esta pasarela? */
  async enabled(provider: GatedWebhookProvider): Promise<boolean> {
    const current = this.snapshot;
    const fresh = current && Date.now() - current.at < WEBHOOK_GATE_TTL_MS ? current : await this.refresh();
    return fresh.enabled.has(provider);
  }

  /** Una consulta a la vez aunque lleguen muchos avisos juntos. */
  private refresh(): Promise<Snapshot> {
    if (!this.inFlight) {
      this.inFlight = this.load()
        .then((snapshot) => {
          this.snapshot = snapshot;
          return snapshot;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  private async load(): Promise<Snapshot> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.gatewayCredential.findMany({
        where: { active: true, provider: { in: [...GATED_WEBHOOK_PROVIDERS] } },
        distinct: ['provider'],
        select: { provider: true },
      }),
    );
    return { at: Date.now(), enabled: new Set(rows.map((r) => r.provider as Provider)) };
  }
}

/** "Avisos de pasarelas: abiertos PEANPE; cerrados PAYTEF (404: …). REDSYS y WIPAY, siempre abiertos." */
export function bootLine(enabled: ReadonlySet<Provider>): string {
  const open = GATED_WEBHOOK_PROVIDERS.filter((p) => enabled.has(p));
  const closed = GATED_WEBHOOK_PROVIDERS.filter((p) => !enabled.has(p));
  const parts = [
    open.length > 0 ? `abiertos ${open.join(', ')}` : null,
    closed.length > 0 ? `cerrados ${closed.join(', ')} (404: ningún local tiene credencial activa)` : null,
  ].filter(Boolean);
  return `Avisos de pasarelas: ${parts.join('; ')}. REDSYS y WIPAY, siempre abiertos.`;
}
