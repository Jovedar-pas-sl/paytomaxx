/**
 * Topes de la recepción del datáfono (seguridad #3). El datáfono actúa como
 * el local (sin persona): con su credencial se crea saldo, así que además del
 * tope por minuto hay un tope de 24 h por datáfono y otro por saldo (sumando
 * tarjeta y efectivo, también lo cargado por otras vías al mismo saldo).
 * Se cambian con POS_RECEPTION_TERMINAL_DAILY_CAP_EUR y
 * POS_RECEPTION_WALLET_DAILY_CAP_EUR (euros; vacío o inválido = lo de por defecto).
 */

export const RECEPTION_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_DAILY_CAP_CENTS = 15_000_00;
export const DEFAULT_WALLET_DAILY_CAP_CENTS = 5_000_00;

export interface ReceptionCaps {
  terminalCents: number;
  walletCents: number;
}

function eurosToCents(raw: string | undefined, fallback: number): number {
  const euros = Number((raw ?? '').trim());
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(euros) && euros > 0 ? Math.round(euros * 100) : fallback;
}

export function receptionCaps(env: Record<string, string | undefined> = process.env): ReceptionCaps {
  return {
    terminalCents: eurosToCents(env.POS_RECEPTION_TERMINAL_DAILY_CAP_EUR, DEFAULT_TERMINAL_DAILY_CAP_CENTS),
    walletCents: eurosToCents(env.POS_RECEPTION_WALLET_DAILY_CAP_EUR, DEFAULT_WALLET_DAILY_CAP_CENTS),
  };
}

export type ReceptionLimit = 'terminal_daily' | 'wallet_daily';

/** ¿Esta recarga pasa algún tope? `walletUsedCents` null = saldo nuevo. */
export function receptionLimitHit(args: {
  amountCents: number;
  terminalUsedCents: number;
  walletUsedCents: number | null;
  caps: ReceptionCaps;
}): ReceptionLimit | null {
  if (args.terminalUsedCents + args.amountCents > args.caps.terminalCents) return 'terminal_daily';
  if (args.walletUsedCents !== null && args.walletUsedCents + args.amountCents > args.caps.walletCents) {
    return 'wallet_daily';
  }
  return null;
}

export const RECEPTION_LIMIT_MESSAGES: Record<ReceptionLimit, string> = {
  terminal_daily: 'Este datáfono ha llegado al tope de recargas de 24 horas: no se ha cobrado. Avisa al dueño.',
  wallet_daily: 'Este saldo ha llegado al tope de recargas de 24 horas: no se ha cobrado. Avisa al dueño.',
};
