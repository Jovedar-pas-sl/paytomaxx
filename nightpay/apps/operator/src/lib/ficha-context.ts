/**
 * Lo que la chica estaba haciendo cuando acerca una ficha a un iPhone: el
 * iPhone abre el enlace de la ficha en otra pestaña (?ficha=…) y esa pestaña
 * necesita saber qué cobro pagar o a qué saldo darle la ficha.
 */

/** De quién es (la chica con la sesión abierta): otra sesión no lo usa. */
export type FichaContext = { userId: string } & (
  | { kind: 'cobro'; chargeId: string; amountCents: number; serviceName: string | null; expiresAt: string }
  | { kind: 'dar'; code: string; at: number }
);

const KEY = 'np_ficha';
/** "Dar ficha" en iPhone: hay que acercarla en este rato. */
const GIVE_WINDOW_MS = 3 * 60 * 1000;

export function saveFichaContext(ctx: FichaContext): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ctx));
  } catch {
    // Sin almacenamiento (modo privado): en iPhone se paga con el código.
  }
}

/** Lo pendiente de esta chica, si aún vale (cobro sin caducar, "dar ficha" reciente). */
export function readFichaContext(userId: string, now = Date.now()): FichaContext | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const ctx = JSON.parse(raw) as FichaContext;
    if (ctx.userId !== userId) return null;
    if (ctx.kind === 'cobro' && typeof ctx.chargeId === 'string' && new Date(ctx.expiresAt).getTime() > now) return ctx;
    if (ctx.kind === 'dar' && typeof ctx.code === 'string' && now - ctx.at < GIVE_WINDOW_MS) return ctx;
    return null;
  } catch {
    return null;
  }
}

/** Borra lo pendiente (si se pasa `match`, solo si es eso). */
export function clearFichaContext(match?: (ctx: FichaContext) => boolean): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    if (match && !match(JSON.parse(raw) as FichaContext)) return;
    localStorage.removeItem(KEY);
  } catch {
    // Nada que borrar.
  }
}
