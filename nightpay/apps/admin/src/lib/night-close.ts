// Cierre de la noche en pasos (panel): lógica pura de la pantalla de cierre.
// Las reglas de verdad (efectivo esperado, qué bloquea, qué hay que confirmar)
// vienen de @nightpay/contracts: el API cierra con las mismas.

import {
  MAX_TYPED_AMOUNT_CENTS,
  NIGHT_CLOSE_STEP_KEYS,
  closeNoteRequired,
  evaluateCash,
  nightCloseRefusal,
  parseEuroCents,
  withCashInput,
  type CashInput,
  type CashOutcome,
  type CashReason,
  type NightCash,
  type NightCashCountResult,
  type NightCloseLink,
  type NightCloseStatus,
  type NightCloseStep,
  type NightCloseStepKey,
  type NightPartnerCash,
} from '@nightpay/contracts';
import { formatEur } from './money';
import type { PanelTab, TabKey } from './roles';

/** Efectivo tecleado: undefined = vacío (no lo ha puesto), null = no es un importe. */
export function parseCashInput(text: string): number | null | undefined {
  const s = text.trim();
  if (s === '') return undefined;
  // parseEuroCents no acepta 0; en la caja, «0» es una respuesta válida.
  if (/^0+(?:[.,]0{1,2})?\s*€?$/.test(s)) return 0;
  return parseEuroCents(s, MAX_TYPED_AMOUNT_CENTS);
}

/** Lo que hay tecleado en el paso del efectivo. */
export interface CashDraft {
  /** Fondo de caja (solo si no se puso al abrir, o para corregirlo). */
  floatText: string;
  countedText: string;
}

/**
 * Lo tecleado → la entrada de las reglas (lo que no es un importe cuenta como
 * vacío). `floatApproved`: el dueño puso su código 2FA para cambiar el fondo
 * apuntado al abrir (el API lo comprueba al cerrar).
 */
export function cashInputOf(draft: CashDraft, floatApproved = false): CashInput {
  const float = parseCashInput(draft.floatText);
  const counted = parseCashInput(draft.countedText);
  return {
    openingFloatCents: typeof float === 'number' ? float : undefined,
    countedCents: typeof counted === 'number' ? counted : undefined,
    ...(floatApproved ? { floatChangeApproved: true } : {}),
  };
}

/** Los pasos con el efectivo tecleado (como los recalcula el API al cerrar). */
export function effectiveSteps(
  steps: ReadonlyArray<NightCloseStep>,
  cash: NightCash,
  draft: CashDraft,
  floatApproved = false,
): NightCloseStep[] {
  return withCashInput(steps, cash, cashInputOf(draft, floatApproved));
}

export function cashOutcome(cash: NightCash, draft: CashDraft, floatApproved = false): CashOutcome {
  return evaluateCash(cash, cashInputOf(draft, floatApproved));
}

// ─── Cierre a ciegas (B9) ───────────────────────────────────────────
// Al cerrar, nadie ve lo que debería haber hasta escribir lo contado y
// pulsar «Ver si cuadra»: así nadie cuadra a ojo. Y con la noche abierta, a
// la encargada (no al dueño) el API ni le manda el fondo ni el efectivo de la
// caja (Noches → En vivo y el mapa del dinero: cashHidden, blind-cash.ts).
// Mientras, lo tecleado no cuenta: el paso «Efectivo» sigue sin contar y
// su texto no lleva cifras que lo dejen calcular (ni la diferencia, que
// también lo diría).

/** Lo que ve la encargada en lugar del fondo y la caja esperada con la noche abierta. */
export const BLIND_CASH_TEXT =
  'Cierre a ciegas: el fondo y el efectivo de la caja se ven al cerrar la noche, después de contarla.';

/** Textos del paso «Efectivo» a ciegas (sin cifras). */
const BLIND_DETAIL: Partial<Record<CashReason, string>> = {
  'count-missing': 'Cuenta el efectivo de la caja, escríbelo y pulsa «Ver si cuadra»: lo que debería haber sale después.',
  'float-missing': 'Apunta con cuánto empezó la caja (el fondo) y cuéntala.',
  negative:
    'Lo que debería haber sale negativo: salió más efectivo del que entró más el fondo. Revisa el fondo y los pagos en efectivo de la noche.',
};

/** Lo tecleado que cuenta: lo contado, solo si ya se dio por contado. */
function countedDraft(draft: CashDraft, countDone: boolean): CashDraft {
  return countDone ? draft : { ...draft, countedText: '' };
}

/** ¿Se puede pulsar «Ver si cuadra»? Con un importe escrito (0 vale). */
export function countReady(draft: CashDraft): boolean {
  return typeof parseCashInput(draft.countedText) === 'number';
}

/**
 * «Volver a contar» tras «Ver si cuadra»: el primer recuento se guarda (el Z y
 * el registro llevan los dos); si ya se había vuelto a contar, sigue el primero.
 */
export function firstCountOf(previous: number | null, draft: CashDraft): number | null {
  if (previous !== null) return previous;
  const counted = parseCashInput(draft.countedText);
  return typeof counted === 'number' ? counted : null;
}

/** El primer recuento que va al cerrar: solo si se volvió a contar y el último está dado por contado. */
export function firstCountToSend(first: number | null, countDone: boolean): number | undefined {
  return first !== null && countDone ? first : undefined;
}

/**
 * Los pasos del cierre con el efectivo tecleado. Sin dar por contado, como si
 * no se hubiera contado y sin cifras en el paso «Efectivo».
 */
export function closeSteps(
  steps: ReadonlyArray<NightCloseStep>,
  cash: NightCash,
  draft: CashDraft,
  opts: { countDone: boolean; floatApproved?: boolean; blindCount?: NightCashCountResult | null },
): NightCloseStep[] {
  // A ciegas (la encargada): el panel no tiene ninguna cifra; el paso lo dice el API al contar.
  if (cash.cashHidden) return blindCloseSteps(steps, opts.countDone ? (opts.blindCount ?? null) : null);
  const used = countedDraft(draft, opts.countDone);
  const floatApproved = opts.floatApproved ?? false;
  const out = effectiveSteps(steps, cash, used, floatApproved);
  if (opts.countDone) return out;
  const blind = BLIND_DETAIL[cashOutcome(cash, used, floatApproved).reason];
  return blind ? out.map((s) => (s.key === 'efectivo' ? { ...s, detail: blind } : s)) : out;
}

/**
 * Los pasos a ciegas: el de «Efectivo», el del API (sin cifras) hasta contar;
 * después, lo que dijo el API con lo contado («Ver si cuadra»).
 */
export function blindCloseSteps(steps: ReadonlyArray<NightCloseStep>, count: NightCashCountResult | null): NightCloseStep[] {
  return steps.map((s) => (s.key === 'efectivo' && count ? { ...s, status: count.status, detail: count.detail } : s));
}

/** Lo que se manda al API con «Ver si cuadra» a ciegas: lo contado y, si no se apuntó al abrir, el fondo. */
export function blindCountInput(draft: CashDraft): { countedCents: number; openingFloatCents?: number } | null {
  const counted = parseCashInput(draft.countedText);
  if (typeof counted !== 'number') return null;
  const float = parseCashInput(draft.floatText);
  return { countedCents: counted, ...(typeof float === 'number' ? { openingFloatCents: float } : {}) };
}

/** Lo que se manda al congelar el Z: lo contado solo si se dio por contado. */
export function closeCashInput(draft: CashDraft, countDone: boolean): CashInput {
  return cashInputOf(countedDraft(draft, countDone));
}

/**
 * Cambiar al cerrar el fondo apuntado al abrir: solo el dueño, con su código
 * 2FA (6 cifras; el API lo comprueba). null: no hace falta código (el fondo no
 * cambió). Si no, el código que se manda (o undefined si aún no vale).
 */
export function floatChangeCode(
  cash: NightCash,
  draft: CashDraft,
  who: { isOwner: boolean; code: string },
): { needed: false } | { needed: true; code: string | undefined } {
  // A ciegas, el panel no sabe el fondo apuntado: si es otro, lo dice el API (y lo aprueba el dueño).
  if (cash.cashHidden || !cashOutcome(cash, draft).floatChanged) return { needed: false };
  const code = who.isOwner && /^\d{6}$/.test(who.code) ? who.code : undefined;
  return { needed: true, code };
}

/** Lo que se dice al encargado que cambia el fondo apuntado al abrir. */
export const FLOAT_OWNER_ONLY_TEXT =
  'Solo el dueño puede cambiar al cerrar el fondo apuntado al abrir (con su 2FA). Deja el que se apuntó o pídeselo.';

/** Diferencia de caja en palabras: «Faltan 12,50 €», «Sobran 5,00 €», «Cuadra». */
export function diffLabel(diffCents: number): string {
  if (diffCents === 0) return 'Cuadra';
  return `${diffCents < 0 ? 'Faltan' : 'Sobran'} ${formatEur(Math.abs(diffCents))}`;
}

/**
 * «Recargas del saldo en efectivo: 80,00 € (2).» (los Z de antes no traen el
 * número). Con la comisión del servicio: «… (1) + 6,00 € de comisión del
 * servicio (se debe a OxioPay).»
 */
export function cajaInText(caja: {
  cashInCents: number;
  walletCashTopUpsCount?: number;
  walletCashTopUpsCents?: number;
  walletCashTopUpFeesCents?: number;
}): string {
  const count = caja.walletCashTopUpsCount;
  const fee = caja.walletCashTopUpFeesCents ?? 0;
  return `Recargas del saldo en efectivo: ${formatEur(caja.walletCashTopUpsCents ?? caja.cashInCents)}${
    typeof count === 'number' ? ` (${count})` : ''
  }${fee !== 0 ? ` + ${formatEur(fee)} de comisión del servicio (se debe a OxioPay)` : ''}.`;
}

/**
 * «Saldo devuelto en efectivo: 45,00 € (1) · pagos a las chicas en efectivo:
 * 7,51 € (1) · a los camareros: 7,50 € (1).» Los Z congelados antes del
 * 28-oct-2026 no separan a los camareros: sus pagos son «al personal».
 */
export function cajaOutText(caja: {
  walletCashPayoutsCount: number;
  walletCashPayoutsCents: number;
  chicaCashPayoutsCount: number;
  chicaCashPayoutsCents: number;
  camareroCashPayoutsCount?: number;
  camareroCashPayoutsCents?: number;
  bitcoinCashOutCount?: number;
  bitcoinCashOutCents?: number;
}): string {
  const wallet = `Saldo devuelto en efectivo: ${formatEur(caja.walletCashPayoutsCents)} (${caja.walletCashPayoutsCount})`;
  const staff = `${formatEur(caja.chicaCashPayoutsCents)} (${caja.chicaCashPayoutsCount})`;
  if (caja.camareroCashPayoutsCount === undefined) return `${wallet} · pagos al personal en efectivo: ${staff}.`;
  const camareros =
    caja.camareroCashPayoutsCount > 0
      ? ` · a los camareros: ${formatEur(caja.camareroCashPayoutsCents ?? 0)} (${caja.camareroCashPayoutsCount})`
      : '';
  // Lo pagado con bitcoin y devuelto en efectivo (el bitcoin se queda en la cartera).
  const bitcoin =
    (caja.bitcoinCashOutCount ?? 0) > 0
      ? ` · pagos con bitcoin devueltos en efectivo: ${formatEur(caja.bitcoinCashOutCents ?? 0)} (${caja.bitcoinCashOutCount})`
      : '';
  return `${wallet} · pagos a las compañeras en efectivo: ${staff}${camareros}${bitcoin}.`;
}

/** Una línea de «Fuera de este cajón»: «Caja · {socio} (3)» y su importe. */
export interface PartnerCashLine {
  key: string;
  label: string;
  amount: string;
  /** La línea entera: «Caja · {socio} (3) 90,00 €». */
  text: string;
}

export interface PartnerCashBlock {
  title: string;
  lines: PartnerCashLine[];
  note: string;
}

export const PARTNER_CASH_TITLE = 'Fuera de este cajón';
export const PARTNER_CASH_NOTE = 'Lo cobran sus cajeros: se cuenta aparte, contra «Movimientos».';

/**
 * El efectivo que cobraron los cajeros de otras plataformas (API de socios):
 * es del local pero no está en este cajón (no entra en lo que debería haber).
 * Una línea por plataforma (cargas − anulaciones; en negativo si esa noche
 * solo hubo anulaciones). Sin ninguna, o con un API de antes, null.
 */
export function partnerCashBlock(partnerCash: ReadonlyArray<NightPartnerCash> | undefined): PartnerCashBlock | null {
  if (!partnerCash || partnerCash.length === 0) return null;
  const lines = partnerCash.map((p, i) => {
    const count = p.count < 0 ? `−${Math.abs(p.count)}` : String(p.count);
    const label = `Caja · ${p.name} (${count})`;
    const amount = formatEur(p.cents);
    return { key: `${i}-${p.name}`, label, amount, text: `${label} ${amount}` };
  });
  return { title: PARTNER_CASH_TITLE, lines, note: PARTNER_CASH_NOTE };
}

/** Un aviso confirmado: el paso y cómo estaba al confirmarlo (su huella). */
export interface StepAck {
  readonly key: NightCloseStepKey;
  readonly print: string;
}

/**
 * La huella de un paso: lo que se confirmó (el texto con sus importes, el
 * recuento y cada cosa con su importe; sin las etiquetas, que llevan «hace N
 * min»). Si cambia, el aviso es otro y hay que volver a confirmarlo.
 */
export function stepPrint(step: NightCloseStep): string {
  const items = step.items.map((i) => `${i.id}:${i.status}:${i.amountCents ?? ''}`).join(',');
  return `${step.count}|${step.detail}|${items}`;
}

/** Marca un aviso como visto tal como está ahora (o lo desmarca), sin cambiar la lista de entrada. */
export function toggleAck(acks: ReadonlyArray<StepAck>, step: NightCloseStep, on: boolean): StepAck[] {
  const rest = acks.filter((a) => a.key !== step.key);
  return on ? [...rest, { key: step.key, print: stepPrint(step) }] : rest;
}

/**
 * Los avisos que siguen confirmados con los pasos de ahora: el paso sigue en
 * aviso y no ha cambiado desde que se confirmó (p. ej. «Faltan 12,50 €» que
 * pasa a «Faltan 32,50 €» tras otra recarga ya no cuenta como visto).
 */
export function ackedKeys(acks: ReadonlyArray<StepAck>, steps: ReadonlyArray<NightCloseStep>): NightCloseStepKey[] {
  const byKey = new Map(steps.map((s) => [s.key, s] as const));
  return acks
    .filter((a) => {
      const s = byKey.get(a.key);
      return s?.status === 'warn' && stepPrint(s) === a.print;
    })
    .map((a) => a.key);
}

export interface FreezeState {
  canFreeze: boolean;
  /** Por qué no se puede aún (para leer debajo del botón). */
  reason: string | null;
  noteRequired: boolean;
}

/** ¿Se puede pulsar «Cerrar la noche»? Mismas reglas que el API (nightCloseRefusal). */
export function freezeState(
  steps: ReadonlyArray<NightCloseStep>,
  acks: ReadonlyArray<NightCloseStepKey>,
  note: string,
): FreezeState {
  const refusal = nightCloseRefusal(steps, acks, note);
  const noteRequired = closeNoteRequired(steps);
  if (!refusal) return { canFreeze: true, reason: null, noteRequired };
  if (refusal.kind === 'note-required') {
    return { canFreeze: false, reason: 'Escribe por qué cierras con cobros sin terminar.', noteRequired };
  }
  const titles = refusal.steps.map((s) => `«${s.title}»`).join(', ');
  return {
    canFreeze: false,
    reason: refusal.kind === 'blocked' ? `Falta resolver: ${titles}.` : `Confirma que lo has visto: ${titles}.`,
    noteRequired,
  };
}

/** Cómo se lee cada estado (texto, no solo color). */
export const STATUS_LABEL: Record<NightCloseStatus, string> = {
  ok: 'Listo',
  warn: 'Aviso',
  block: 'Bloquea',
};

/** Pestaña del panel a la que lleva un paso (null si no hay o este rol no la ve). */
export function stepTab(link: NightCloseLink | null, tabs: ReadonlyArray<PanelTab>): PanelTab | null {
  if (!link) return null;
  const key: TabKey = link;
  return tabs.find((t) => t.key === key) ?? null;
}

/**
 * ¿Se pinta abierto este paso? (entrega 10 A). El que llegó «Listo» en la
 * primera carga, plegado; el que se pone «Listo» con la pantalla abierta, como
 * estaba (así «Ver si cuadra» no esconde «Volver a contar» y el refresco no
 * mueve nada) hasta que se toque su fila (`elegido`). Lo que no está listo,
 * siempre abierto; el informe Z, también.
 */
export function pasoAbierto(p: { key: NightCloseStepKey; status: NightCloseStatus; listoAlCargar: boolean; elegido?: boolean }): boolean {
  if (p.key === 'z' || p.status !== 'ok') return true;
  if (p.elegido !== undefined) return p.elegido;
  return !p.listoAlCargar;
}

/** Cuántos pasos están listos (para la barra de progreso): los ok y los avisos ya confirmados. */
export function readyCount(steps: ReadonlyArray<NightCloseStep>, acks: ReadonlyArray<NightCloseStepKey> = []): number {
  return steps.filter((s) => s.status === 'ok' || (s.status === 'warn' && acks.includes(s.key))).length;
}

/**
 * Pasos que manda el API en un 409 (NIGHT_CLOSE_BLOCKED / NEEDS_ACK); null si
 * el cuerpo no los trae o no son pasos.
 */
export function stepsFromBody(text: string): NightCloseStep[] | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const steps = (body as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || !steps.every(isStep)) return null;
  return steps;
}

const STEP_KEYS: ReadonlySet<string> = new Set(NIGHT_CLOSE_STEP_KEYS);
const STATUSES: ReadonlySet<string> = new Set(['ok', 'warn', 'block']);

function isStep(v: unknown): v is NightCloseStep {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.key === 'string' &&
    STEP_KEYS.has(s.key) &&
    typeof s.status === 'string' &&
    STATUSES.has(s.status) &&
    typeof s.title === 'string' &&
    typeof s.detail === 'string' &&
    Array.isArray(s.items)
  );
}

/**
 * Los cobros sin resolver de la noche abierta: no todos se resuelven en el
 * mismo sitio (en Hoy → Cobros, «Resolver» solo sale con el banco sin
 * confirmar o esperando más de 15 min), así que cada uno dice qué hacer.
 */
export function pendingHeading(count: number): string {
  const what = count === 1 ? '1 cobro sin resolver' : `${count} cobros sin resolver`;
  return `${what}. Antes de cerrar, haz lo que dice cada uno:`;
}

/** Qué es cada pendiente y qué hacer con él. */
export function pendingTodo(p: { status: string; captureMethod: string | null; provider?: string | null }): string {
  if (p.captureMethod === 'POS_EXTERNAL') return 'datáfono sin confirmar: que quien cobró lo confirme con el ticket en la app, o caduca solo';
  // Con bitcoin no hay banco: su factura en BTCPay dice si se pagó.
  if (p.provider === 'BTCPAY') return 'pagando con bitcoin: mira su factura en tu BTCPay; si a los 15 min sigue, «Resolver» en Hoy → Cobros con el id de la factura';
  if (p.status === 'ORPHAN') return 'el banco no lo confirmó: búscalo en BBVA y dilo con «Resolver» en Hoy → Cobros';
  if (p.status === 'AUTHORIZING') return 'esperando al banco: suele llegar solo; si a los 15 min sigue, «Resolver» en Hoy → Cobros';
  return 'recarga en el datáfono a medias: se termina en el datáfono o caduca sola';
}
