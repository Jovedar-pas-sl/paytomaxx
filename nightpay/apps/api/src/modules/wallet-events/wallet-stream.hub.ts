import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

/**
 * Las páginas del saldo (/w/:token) abiertas en ESTA réplica, cada una con
 * su conexión SSE (GET /w/:token/events, PublicWalletEventsController). Cuando
 * llega el aviso de que su saldo cambió (WalletEventsListener), se les manda
 * «cambió» y la página vuelve a pedir su estado (/w/:token/state). Por aquí no
 * va ningún dato del saldo: solo el aviso y la hora.
 *
 * Eventos (text/event-stream):
 *   hello    al abrir (la página sabe que el tiempo real va)
 *   change   tu saldo cambió: pide /state
 *   resync   volvió la escucha tras un corte: pide /state (con algo de azar)
 *   bye      se cierra: {r:'renew'} vuelve a entrar ya (sesión o tope de vida),
 *            {r:'restart'} la réplica se apaga (vuelve en unos segundos, a la
 *            nueva), {r:'cap'} hay más pestañas de este saldo (no vuelve: sigue
 *            con el sondeo de respaldo)
 *   «: ♥»    latido (comentario) cada STREAM_HEARTBEAT_MS
 *
 * Topes (por réplica): STREAM_MAX_PER_WALLET por saldo (la más vieja se va) y
 * STREAM_MAX_PER_IP por IP (el wifi de un local es una sola IP: holgado).
 */

/** Cloudflare corta a los 100 s sin bytes; los proxies, antes. */
export const STREAM_HEARTBEAT_MS = 20_000;
/** Lo más que dura una conexión: luego la página vuelve a entrar (y se vuelve a mirar su sesión). */
export const STREAM_MAX_LIFETIME_MS = 10 * 60_000;
/** Pestañas abiertas del mismo saldo a la vez. */
export const STREAM_MAX_PER_WALLET = 4;
/** Conexiones a la vez desde una IP (muchos clientes comparten el wifi del local). */
export const STREAM_MAX_PER_IP = 400;
/** Lo que espera el navegador para reconectar solo (la página lo hace antes, a su manera). */
const RETRY_HINT_MS = 10_000;

/** Por dónde se escribe a una página (la respuesta HTTP de su conexión). */
export interface WalletStreamSink {
  write(chunk: string): unknown;
  end(): void;
}

export interface WalletStream {
  readonly walletId: string;
  readonly ip: string;
  readonly openedAt: number;
  /** Cuándo se cierra (la sesión de la página caduca o el tope de vida). */
  readonly closeAt: number;
  readonly sink: WalletStreamSink;
}

export type ByeReason = 'renew' | 'restart' | 'cap';
export type OpenResult = { ok: true; stream: WalletStream } | { ok: false; reason: 'ip-limit' | 'closing' };

@Injectable()
export class WalletStreamHub implements OnModuleDestroy {
  private readonly logger = new Logger(WalletStreamHub.name);
  private readonly byWallet = new Map<string, Set<WalletStream>>();
  private readonly byIp = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private closing = false;

  /** Conexiones abiertas ahora en esta réplica. */
  get size(): number {
    let n = 0;
    for (const set of this.byWallet.values()) n += set.size;
    return n;
  }

  /** ¿Cabe otra conexión desde esta IP? (antes de contestar 200) */
  canOpen(ip: string): boolean {
    return !this.closing && (this.byIp.get(ip) ?? 0) < STREAM_MAX_PER_IP;
  }

  open(input: Omit<WalletStream, 'openedAt'>, now: number = Date.now()): OpenResult {
    if (this.closing) return { ok: false, reason: 'closing' };
    if (!this.canOpen(input.ip)) return { ok: false, reason: 'ip-limit' };
    const stream: WalletStream = { ...input, openedAt: now };
    const set = this.byWallet.get(stream.walletId) ?? new Set<WalletStream>();
    while (set.size >= STREAM_MAX_PER_WALLET) {
      const oldest = [...set].sort((a, b) => a.openedAt - b.openedAt)[0];
      if (!oldest) break;
      this.bye(oldest, 'cap');
    }
    set.add(stream);
    this.byWallet.set(stream.walletId, set);
    this.byIp.set(stream.ip, (this.byIp.get(stream.ip) ?? 0) + 1);
    if (this.send(stream, `retry: ${RETRY_HINT_MS}\n\n${event('hello', { at: now })}`)) this.startTimer();
    return { ok: true, stream };
  }

  /** La conexión se cerró (el navegador se fue): fuera. Repetirlo no hace nada. */
  close(stream: WalletStream): void {
    const set = this.byWallet.get(stream.walletId);
    if (!set?.delete(stream)) return;
    if (set.size === 0) this.byWallet.delete(stream.walletId);
    const left = (this.byIp.get(stream.ip) ?? 1) - 1;
    if (left > 0) this.byIp.set(stream.ip, left);
    else this.byIp.delete(stream.ip);
    if (this.byWallet.size === 0) this.stopTimer();
  }

  /** El saldo cambió: «cambió» a sus páginas. */
  notify(walletId: string, now: number = Date.now()): void {
    const set = this.byWallet.get(walletId);
    if (!set) return;
    const chunk = event('change', { at: now });
    for (const stream of [...set]) this.send(stream, chunk);
  }

  /** Volvió la escucha tras un corte: todas se ponen al día. */
  resync(now: number = Date.now()): void {
    const chunk = event('resync', { at: now });
    for (const stream of this.all()) this.send(stream, chunk);
  }

  /** Latido y cierre de las que llegaron a su hora. */
  tick(now: number = Date.now()): void {
    for (const stream of this.all()) {
      if (now >= stream.closeAt) this.bye(stream, 'renew');
      else this.send(stream, ': ♥\n\n');
    }
  }

  /** Al apagar la réplica: «vuelve» a todas, y ya no se abren más. */
  closeAll(): void {
    this.closing = true;
    const open = this.all();
    for (const stream of open) this.bye(stream, 'restart');
    this.stopTimer();
    if (open.length > 0) this.logger.log(`Avisos del saldo: ${open.length} páginas avisadas de que esta réplica se apaga`);
  }

  onModuleDestroy(): void {
    this.closeAll();
  }

  private all(): WalletStream[] {
    return [...this.byWallet.values()].flatMap((set) => [...set]);
  }

  private bye(stream: WalletStream, reason: ByeReason): void {
    this.send(stream, event('bye', { r: reason }));
    this.close(stream);
    try {
      stream.sink.end();
    } catch {
      // Ya estaba cerrada.
    }
  }

  /** false si la conexión ya no acepta bytes (y entonces se quita). */
  private send(stream: WalletStream, chunk: string): boolean {
    try {
      stream.sink.write(chunk);
      return true;
    } catch {
      this.close(stream);
      return false;
    }
  }

  private startTimer(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => this.tick(), STREAM_HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function event(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
