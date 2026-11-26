import {
  MAX_CHARGE_CENTS,
  isPostCode,
  isSectionCode,
  packComponentsOf,
  postSection,
  roleDefaultSection,
  type ChargeLineInput,
  type ChargeLineView,
  type SectionCode,
} from '@nightpay/contracts';

/**
 * El mapa del dinero (lógica pura, sin Prisma): de lo que pide quien cobra a
 * las líneas del cobro, cada una en su sección. Nunca «Otros» (EXTRA): la
 * sección sale, en este orden, de
 *   1. las líneas explícitas (`lines`);
 *   2. el servicio de la carta (un pack da una línea por parte);
 *   3. la sección que pide la petición (revenueCategory; EXTRA no cuenta);
 *   4. el puesto de quien cobra (users.post: Barra → Copas…);
 *   5. su rol (la chica, Servicios; el resto, Copas).
 * Las apps antiguas (un importe o un servicio, sin líneas) siguen valiendo:
 * su petición da una línea (o una por parte del pack).
 */

/** Servicio de la carta tal como se lee (ServiceItem). */
export interface CartaItemLike {
  id: string;
  name: string;
  priceCents: number;
  durationMin: number | null;
  category: string;
  active: boolean;
  components: unknown;
  /** «Copa con invitación» (en Copas): la venta se reparte con la chica invitada. */
  isInvitation?: boolean;
}

/** Línea lista para guardar (payment_lines). */
export interface DraftLine {
  category: SectionCode;
  serviceItemId: string | null;
  label: string;
  qty: number;
  unitCents: number;
  amountCents: number;
  /** «Copa con invitación»: la chica invitada y las partes fijadas al cobrar. */
  beneficiaryOperatorId?: string | null;
  beneficiaryCents?: number | null;
  chargerCents?: number | null;
  /** Cobro por el encargado: la compañera del servicio (solo en Servicios) y su % fijado al cobrar. */
  serviceOperatorId?: string | null;
  operatorCommissionBps?: number | null;
}

export interface ResolvedCharge {
  lines: DraftLine[];
  amountCents: number;
  /** La sección con más importe: va en payments.revenueCategory y en el consumo del saldo. */
  primaryCategory: SectionCode;
  /** El servicio del cobro si es uno solo de la carta (como antes); si no, null. */
  service: { serviceItemId: string; serviceName: string; durationMin: number | null } | null;
  /** Lo vendido en una línea («2× Copa · Habitación»); null si es solo un importe tecleado. */
  serviceName: string | null;
  /**
   * Lo tecleado a mano («Otro importe»): las líneas sin servicio de la carta.
   * Es lo único del cobro que cuenta para el tope del local; la carta no, tampoco en una cuenta mixta.
   */
  typedCents: number;
}

export type ChargeLinesError = 'item-missing' | 'item-inactive' | 'no-amount' | 'too-much';

export type ChargeLinesResult = { ok: true; charge: ResolvedCharge } | { ok: false; reason: ChargeLinesError };

export interface ChargeLinesRequest {
  /** Líneas explícitas (apps nuevas). */
  lines?: readonly ChargeLineInput[] | null;
  /** Petición antigua de una línea: un servicio de la carta… */
  serviceItemId?: string | null;
  /** …o un importe. */
  amountCents?: number | null;
  /** Sección pedida (petición antigua). EXTRA = sin sección. */
  requestedCategory?: string | null;
  /** Puesto de quien cobra (users.post). */
  puesto?: string | null;
  role?: string | null;
  /** Los servicios de la carta que nombra la petición (de este local). */
  items: ReadonlyMap<string, CartaItemLike>;
}

/** Texto en español de cada error (las apps lo enseñan tal cual). */
export const CHARGE_LINES_ERRORS: Readonly<Record<ChargeLinesError, string>> = {
  'item-missing': 'Ese servicio no está en la carta de este local',
  'item-inactive': 'Ese servicio está desactivado en la carta',
  'no-amount': 'Pon el importe',
  'too-much': 'Un cobro no puede pasar de 10.000,00 €',
};

const MAX_SERVICE_NAME = 120;
const TYPED_LABEL = 'Otro importe';

/** La sección de un cobro sin carta ni líneas: la pedida, la del puesto o la del rol. */
export function fallbackSection(req: Pick<ChargeLinesRequest, 'requestedCategory' | 'puesto' | 'role'>): SectionCode {
  if (isSectionCode(req.requestedCategory)) return req.requestedCategory;
  if (isPostCode(req.puesto)) return postSection(req.puesto);
  return roleDefaultSection(req.role);
}

/** Las líneas de un servicio de la carta (un pack, una por parte). */
function itemLines(item: CartaItemLike, qty: number, fallback: SectionCode): DraftLine[] {
  const parts = packComponentsOf(item.components);
  const sum = parts?.reduce((acc, p) => acc + p.amountCents, 0);
  if (parts && sum === item.priceCents) {
    return parts.map((p) => ({
      category: p.category,
      serviceItemId: item.id,
      label: item.name,
      qty,
      unitCents: p.amountCents,
      amountCents: p.amountCents * qty,
    }));
  }
  // Un servicio antiguo en «Otros» (EXTRA) cae en la sección de quien cobra.
  const category = isSectionCode(item.category) ? item.category : fallback;
  return [{ category, serviceItemId: item.id, label: item.name, qty, unitCents: item.priceCents, amountCents: item.priceCents * qty }];
}

/** Lo que pide la petición, como líneas sin resolver (servicio + unidades, o importe + sección). */
function requestedLines(req: ChargeLinesRequest): ChargeLineInput[] {
  if (req.lines && req.lines.length > 0) return [...req.lines];
  if (req.serviceItemId) return [{ serviceItemId: req.serviceItemId, qty: 1 }];
  if (req.amountCents && req.amountCents > 0) return [{ category: fallbackSection(req), amountCents: req.amountCents }];
  return [];
}

export function resolveChargeLines(req: ChargeLinesRequest): ChargeLinesResult {
  const asked = requestedLines(req);
  if (asked.length === 0) return { ok: false, reason: 'no-amount' };
  const fallback = fallbackSection(req);
  const lines: DraftLine[] = [];
  for (const line of asked) {
    if ('serviceItemId' in line) {
      const item = req.items.get(line.serviceItemId);
      if (!item) return { ok: false, reason: 'item-missing' };
      if (!item.active) return { ok: false, reason: 'item-inactive' };
      lines.push(...itemLines(item, line.qty ?? 1, fallback));
    } else {
      const label = line.label?.trim() || TYPED_LABEL;
      lines.push({ category: line.category, serviceItemId: null, label, qty: 1, unitCents: line.amountCents, amountCents: line.amountCents });
    }
  }
  const amountCents = lines.reduce((acc, l) => acc + l.amountCents, 0);
  if (amountCents <= 0) return { ok: false, reason: 'no-amount' };
  if (amountCents > MAX_CHARGE_CENTS) return { ok: false, reason: 'too-much' };
  return {
    ok: true,
    charge: {
      lines,
      amountCents,
      primaryCategory: primaryCategory(lines),
      service: singleService(asked, req.items),
      serviceName: summaryOf(asked, req.items),
      typedCents: lines.reduce((acc, l) => acc + (l.serviceItemId === null ? l.amountCents : 0), 0),
    },
  };
}

/** La sección con más importe (a igualdad, la primera). */
export function primaryCategory(lines: ReadonlyArray<Pick<DraftLine, 'category' | 'amountCents'>>): SectionCode {
  const totals = new Map<SectionCode, number>();
  for (const l of lines) totals.set(l.category, (totals.get(l.category) ?? 0) + l.amountCents);
  let best: SectionCode = lines[0]?.category ?? 'VENUE_BAR';
  for (const [category, total] of totals) if (total > (totals.get(best) ?? 0)) best = category;
  return best;
}

/** Un solo servicio de la carta, una unidad: se guarda en el cobro como antes (serviceItemId, nombre, minutos). */
function singleService(
  asked: readonly ChargeLineInput[],
  items: ReadonlyMap<string, CartaItemLike>,
): ResolvedCharge['service'] {
  const only = asked.length === 1 ? asked[0] : undefined;
  if (!only || !('serviceItemId' in only) || (only.qty ?? 1) !== 1) return null;
  const item = items.get(only.serviceItemId);
  return item ? { serviceItemId: item.id, serviceName: item.name, durationMin: item.durationMin } : null;
}

/** «2× Copa · Habitación» (los importes tecleados sin nombre no salen). */
function summaryOf(asked: readonly ChargeLineInput[], items: ReadonlyMap<string, CartaItemLike>): string | null {
  const parts = asked
    .map((l) => {
      if (!('serviceItemId' in l)) return l.label?.trim() || null;
      const name = items.get(l.serviceItemId)?.name;
      if (!name) return null;
      const qty = l.qty ?? 1;
      return qty > 1 ? `${qty}× ${name}` : name;
    })
    .filter((s): s is string => Boolean(s));
  if (parts.length === 0) return null;
  const text = parts.join(' · ');
  return text.length > MAX_SERVICE_NAME ? `${text.slice(0, MAX_SERVICE_NAME - 1)}…` : text;
}

/** Los ids de servicio que nombra la petición (para leerlos de la carta de una vez). */
export function requestedItemIds(req: Pick<ChargeLinesRequest, 'lines' | 'serviceItemId'>): string[] {
  const ids = (req.lines ?? []).flatMap((l) => ('serviceItemId' in l ? [l.serviceItemId] : []));
  if (req.serviceItemId && !(req.lines && req.lines.length > 0)) ids.push(req.serviceItemId);
  return [...new Set(ids)];
}

// ─── Comisión de la chica por línea ───────────────────────────────────

export interface LineCommission {
  commissionCents: number;
  /**
   * El % que se guarda en la ganancia: el de la sección si todas las líneas
   * tienen el mismo (como siempre); si no, el efectivo sobre el total.
   */
  commissionBps: number;
  /** Alguna línea le da % (sin ninguna, solo hay ganancia si hay propina). */
  anyBps: boolean;
}

/**
 * Comisión de la chica por línea: las de Servicios con su % (o el del local)
 * y el resto con el % del local para esa sección (normalmente 0). Se agrupa
 * por %: un cobro de una sola sección da EXACTAMENTE lo de siempre
 * (round(total × % / 10000)), sin céntimos de más por redondear línea a línea.
 */
export function lineCommission(lines: ReadonlyArray<{ amountCents: number; bps: number }>): LineCommission {
  const byBps = new Map<number, number>();
  for (const l of lines) byBps.set(l.bps, (byBps.get(l.bps) ?? 0) + l.amountCents);
  let commissionCents = 0;
  for (const [bps, amount] of byBps) commissionCents += Math.round((amount * bps) / 10_000);
  const total = lines.reduce((acc, l) => acc + l.amountCents, 0);
  const only = byBps.size === 1 ? [...byBps.keys()][0]! : null;
  return {
    commissionCents,
    commissionBps: only ?? (total > 0 ? Math.round((commissionCents * 10_000) / total) : 0),
    anyBps: [...byBps.keys()].some((bps) => bps > 0),
  };
}

/** Las líneas tal como las ven las apps y el panel. */
export function lineViews(
  lines: ReadonlyArray<{ category: string; label: string; qty: number; unitCents: number; amountCents: number; serviceItemId: string | null }>,
): ChargeLineView[] {
  return lines.map((l) => ({
    category: l.category as SectionCode,
    label: l.label,
    qty: l.qty,
    unitCents: l.unitCents,
    amountCents: l.amountCents,
    serviceItemId: l.serviceItemId,
  }));
}

/**
 * Las secciones que pide cobrar la petición, para ver si su puesto las puede
 * cobrar: la de cada servicio de la carta (un pack, la suya: sus partes se
 * reparten solas) y la de cada importe tecleado. Un servicio que no está o
 * no se puede cobrar no cuenta (lo para resolveChargeLines).
 */
export function chargedSections(req: ChargeLinesRequest): SectionCode[] {
  const fallback = fallbackSection(req);
  const out = requestedLines(req).flatMap((line): SectionCode[] => {
    if (!('serviceItemId' in line)) return [line.category];
    const item = req.items.get(line.serviceItemId);
    if (!item) return [];
    return [isSectionCode(item.category) ? item.category : fallback];
  });
  return [...new Set(out)];
}
