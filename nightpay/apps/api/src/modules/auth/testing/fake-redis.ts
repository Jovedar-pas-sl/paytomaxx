/**
 * Redis en memoria para los tests del módulo auth (no es código de producción).
 * Solo los comandos que usan sus servicios. La caducidad usa Date.now(), así
 * que vale con vi.useFakeTimers() / vi.setSystemTime().
 */
import { RESERVE_ATTEMPT_LUA } from '../lockout.service';

type ScriptHandler = (fake: FakeRedis, keys: string[], args: string[]) => Promise<unknown>;

interface Entry {
  readonly value: string;
  readonly expiresAt: number | null;
}

interface SetOptions {
  readonly ttlMs: number | null;
  readonly nx: boolean;
  readonly xx: boolean;
  readonly keepTtl: boolean;
}

function parseSetOptions(opts: Array<string | number>): SetOptions {
  const upper = opts.map((o) => String(o).toUpperCase());
  const exAt = upper.indexOf('EX');
  const pxAt = upper.indexOf('PX');
  const ttlMs = exAt >= 0 ? Number(opts[exAt + 1]) * 1000 : pxAt >= 0 ? Number(opts[pxAt + 1]) : null;
  return {
    ttlMs,
    nx: upper.includes('NX'),
    xx: upper.includes('XX'),
    keepTtl: upper.includes('KEEPTTL'),
  };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export class FakeRedis {
  private readonly store = new Map<string, Entry>();
  private readonly scripts = new Map<string, ScriptHandler>();
  /** Como Redis: un script detrás de otro (sin esto, dos a la vez se intercalarían en los await). */
  private scriptQueue: Promise<unknown> = Promise.resolve();

  defineScript(lua: string, handler: ScriptHandler): void {
    this.scripts.set(lua, handler);
  }

  /** Para asertar en los tests: claves vivas. */
  keys(): string[] {
    return Array.from(this.store.keys()).filter((k) => this.alive(k) !== null);
  }

  has(key: string): boolean {
    return this.alive(key) !== null;
  }

  async get(key: string): Promise<string | null> {
    return this.alive(key)?.value ?? null;
  }

  async mget(...keys: Array<string | string[]>): Promise<Array<string | null>> {
    return keys.flat().map((k) => this.alive(k)?.value ?? null);
  }

  async set(key: string, value: string | number, ...opts: Array<string | number>): Promise<'OK' | null> {
    const o = parseSetOptions(opts);
    const current = this.alive(key);
    if ((o.nx && current) || (o.xx && !current)) return null;
    const expiresAt = o.keepTtl ? (current?.expiresAt ?? null) : o.ttlMs !== null ? Date.now() + o.ttlMs : null;
    this.store.set(key, { value: String(value), expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.alive(k) !== null && this.store.delete(k)).length;
  }

  async incr(key: string): Promise<number> {
    const current = this.alive(key);
    const next = Number(current?.value ?? '0') + 1;
    this.store.set(key, { value: String(next), expiresAt: current?.expiresAt ?? null });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const current = this.alive(key);
    if (!current) return 0;
    this.store.set(key, { ...current, expiresAt: Date.now() + seconds * 1000 });
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const current = this.alive(key);
    if (!current) return -2;
    if (current.expiresAt === null) return -1;
    return Math.ceil((current.expiresAt - Date.now()) / 1000);
  }

  async scan(
    _cursor: string,
    _matchToken: 'MATCH',
    pattern: string,
    _countToken: 'COUNT',
    _count: number,
  ): Promise<[string, string[]]> {
    const re = globToRegExp(pattern);
    return ['0', this.keys().filter((k) => re.test(k))];
  }

  async eval(script: string, numKeys: number, ...rest: Array<string | number>): Promise<unknown> {
    const handler = this.scripts.get(script);
    if (!handler) throw new Error('FakeRedis: script Lua no emulado');
    const all = rest.map(String);
    const run = this.scriptQueue.then(() => handler(this, all.slice(0, numKeys), all.slice(numKeys)));
    this.scriptQueue = run.catch(() => undefined);
    return run;
  }

  multi(): FakeMulti {
    return new FakeMulti(this);
  }

  private alive(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }
}

class FakeMulti {
  private readonly ops: Array<() => Promise<unknown>> = [];

  constructor(private readonly redis: FakeRedis) {}

  set(key: string, value: string | number, ...opts: Array<string | number>): this {
    this.ops.push(() => this.redis.set(key, value, ...opts));
    return this;
  }

  del(...keys: string[]): this {
    this.ops.push(() => this.redis.del(...keys));
    return this;
  }

  async exec(): Promise<Array<[null, unknown]>> {
    const results: Array<[null, unknown]> = [];
    for (const op of this.ops) results.push([null, await op()]);
    return results;
  }
}

/**
 * Misma semántica que CLAIM_STEP_LUA (totp-attempts.service): acepta el paso
 * solo si es posterior al último aceptado. Registrar con defineScript().
 */
export async function claimStepScript(fake: FakeRedis, keys: string[], args: string[]): Promise<number> {
  const [key] = keys;
  const [step, ttl] = args;
  if (!key || step === undefined || ttl === undefined) throw new Error('claimStep: argumentos');
  const last = await fake.get(key);
  if (last !== null && Number(step) <= Number(last)) return 0;
  await fake.set(key, step, 'EX', Number(ttl));
  return 1;
}

/**
 * Misma semántica que RESERVE_ATTEMPT_LUA (lockout.service): si alguna clave
 * que cuenta está bloqueada, nada; si no, cuenta en todas y bloquea al umbral.
 * createFakeRedis() ya lo registra.
 */
export async function reserveAttemptScript(fake: FakeRedis, keys: string[], args: string[]): Promise<number[]> {
  const n = keys.length / 2;
  for (let i = 0; i < n; i++) {
    if (args[i * 4 + 3] !== '1') continue;
    const ttl = await fake.ttl(keys[i * 2 + 1]!);
    if (ttl > 0) return [0, i + 1, ttl];
  }
  const out = [1];
  for (let i = 0; i < n; i++) {
    const [fail, locked] = [keys[i * 2]!, keys[i * 2 + 1]!];
    const [threshold, window, lockSec] = [Number(args[i * 4]), Number(args[i * 4 + 1]), Number(args[i * 4 + 2])];
    const c = await fake.incr(fail);
    if (c === 1) await fake.expire(fail, window);
    if (c >= threshold) {
      await fake.set(locked, '1', 'EX', lockSec, 'NX');
      await fake.del(fail);
    }
    out.push(c);
  }
  return out;
}

export function createFakeRedis(): FakeRedis {
  const fake = new FakeRedis();
  fake.defineScript(RESERVE_ATTEMPT_LUA, reserveAttemptScript);
  return fake;
}
