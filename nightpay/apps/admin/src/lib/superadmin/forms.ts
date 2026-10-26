// Formularios de negocios y locales: lo tecleado → lo que se manda al API,
// con el error en llano si algo no vale, y la lista de cambios para la frase
// de confirmación («comisión de la plataforma: 10 % → 12 %»).

import {
  DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS,
  DEFAULT_SERVICE_FEE_BPS,
  MAX_OPERATOR_COBRO_CENTS,
  MAX_SERVICE_FEE_BPS,
  MAX_VENUE_PAYOUT_HOLD_DAYS,
  chargeBreakdownText,
  formatMoney,
  isValidTimeZone,
  normalizeTaxId,
  parseEuroCents,
  serviceFeeCents,
  type BusinessView,
  type CreateBusinessDto,
  type CreateVenueDto,
  type OperatorCommissionDefaults,
  type UpdateBusinessDto,
  type UpdateVenueProfileDto,
  type UpdateVenueRulesDto,
  type VenueDetail,
  type VenueRules,
} from '@nightpay/contracts';
import { bpsToPercentInput, formatPercent, parsePercentToBps } from '../commission';
import { centsToInput, formatEur } from '../money';
import { profileNeedsTotp } from './step-up';
import { CATEGORY_KEYS, CATEGORY_LABELS, VAT_REGIME_LABELS, holdDaysText } from './labels';

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): FormResult<T> => ({ ok: true, value });
const fail = <T>(error: string): FormResult<T> => ({ ok: false, error });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAX_ID = /^[A-Z0-9]{5,20}$/;
const WALLET_GROUP = /^[a-z0-9][a-z0-9_-]*$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ZERO_AMOUNT = /^0+(?:[.,]0{1,2})?$/;

/** Importe en euros que admite 0 ("0", "0,00"); null si no es un importe. */
export function parseCentsAllowZero(input: string, maxCents: number): number | null {
  const s = input.trim().replace(/[\s€]/g, '');
  if (ZERO_AMOUNT.test(s)) return 0;
  return parseEuroCents(s, maxCents);
}

const blankToNull = (s: string): string | null => (s.trim() ? s.trim() : null);

/** «Comisión del servicio»: un % de 0 a 12 (en puntos básicos); null si no vale. */
function parseServiceFeePct(input: string): number | null {
  const bps = parsePercentToBps(input);
  return bps !== null && bps <= MAX_SERVICE_FEE_BPS ? bps : null;
}

const SERVICE_FEE_RANGE = `de 0 a ${formatPercent(MAX_SERVICE_FEE_BPS)}`;

/** Los ejemplos de la ayuda: el servicio de la carta (33 €) y una recarga de 50 €. */
const EXAMPLE_CHARGE_CENTS = 3300;
const EXAMPLE_TOP_UP_CENTS = 5000;

/**
 * La ayuda del % de la «Comisión del servicio», con un ejemplo: «Un cobro de
 * 33 € → el cliente paga 36,30 € (…)». null si lo tecleado no vale.
 */
export function serviceFeeExample(pct: string, kind: 'card' | 'topUp'): string | null {
  if (!pct.trim()) return null;
  const bps = parseServiceFeePct(pct);
  if (bps === null) return null;
  const short = (cents: number) => formatMoney(cents, { compact: true });
  if (kind === 'topUp') {
    const fee = serviceFeeCents(EXAMPLE_TOP_UP_CENTS, bps);
    return `Una recarga de ${short(EXAMPLE_TOP_UP_CENTS)} → el cliente paga ${short(EXAMPLE_TOP_UP_CENTS + fee)} y le quedan ${short(EXAMPLE_TOP_UP_CENTS)} de saldo.`;
  }
  const fee = serviceFeeCents(EXAMPLE_CHARGE_CENTS, bps);
  const breakdown = fee > 0 ? ` (${chargeBreakdownText({ baseCents: EXAMPLE_CHARGE_CENTS, feeCents: fee, tipCents: 0 })})` : '';
  return `Un cobro de ${short(EXAMPLE_CHARGE_CENTS)} → el cliente paga ${short(EXAMPLE_CHARGE_CENTS + fee)}${breakdown}, más la propina si la deja.`;
}

// ─── Negocios ───────────────────────────────────────────────────────

export interface BusinessForm {
  name: string;
  taxId: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  /** Comisión por defecto de sus locales nuevos (%); vacío = la general. */
  commissionPct: string;
  /** «Comisión del servicio» por defecto de sus locales nuevos (%): pagos con tarjeta y recargas. Vacío = 10 %. */
  serviceFeePct: string;
  topUpServiceFeePct: string;
}

export const EMPTY_BUSINESS_FORM: BusinessForm = {
  name: '',
  taxId: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  notes: '',
  commissionPct: '',
  serviceFeePct: '',
  topUpServiceFeePct: '',
};

const pctOrBlank = (bps: number | null | undefined): string => (bps === null || bps === undefined ? '' : bpsToPercentInput(bps));

export function businessFormFrom(b: BusinessView): BusinessForm {
  return {
    name: b.name,
    taxId: b.taxId ?? '',
    contactName: b.contactName ?? '',
    contactEmail: b.contactEmail ?? '',
    contactPhone: b.contactPhone ?? '',
    notes: b.notes ?? '',
    commissionPct: b.defaultPlatformCommissionBps === null ? '' : bpsToPercentInput(b.defaultPlatformCommissionBps),
    serviceFeePct: pctOrBlank(b.defaultServiceFeeBps),
    topUpServiceFeePct: pctOrBlank(b.defaultTopUpServiceFeeBps),
  };
}

type BusinessFields = Required<{ [K in keyof CreateBusinessDto]: Exclude<CreateBusinessDto[K], undefined> }>;

export function businessPayload(form: BusinessForm): FormResult<BusinessFields> {
  const name = form.name.trim();
  if (name.length < 2 || name.length > 160) return fail('La razón social, de 2 a 160 letras.');
  const taxId = form.taxId.trim() ? normalizeTaxId(form.taxId) : null;
  if (taxId !== null && !TAX_ID.test(taxId)) return fail('El NIF/CIF: de 5 a 20 letras o números (B12345678).');
  const email = blankToNull(form.contactEmail);
  if (email !== null && !EMAIL.test(email)) return fail('El email de contacto no es válido.');
  const phone = blankToNull(form.contactPhone);
  if (phone !== null && phone.length > 40) return fail('El teléfono, como mucho 40 caracteres.');
  const notes = form.notes.trim() ? form.notes : null;
  if (notes !== null && notes.length > 4000) return fail('Las notas, como mucho 4000 letras.');
  let commission: number | null = null;
  if (form.commissionPct.trim()) {
    commission = parsePercentToBps(form.commissionPct);
    if (commission === null) return fail('La comisión: un porcentaje de 0 a 100 (por ejemplo 10 o 10,5).');
  }
  const serviceFee = form.serviceFeePct.trim() ? parseServiceFeePct(form.serviceFeePct) : null;
  if (form.serviceFeePct.trim() && serviceFee === null) {
    return fail(`La comisión del servicio en los pagos con tarjeta: ${SERVICE_FEE_RANGE}.`);
  }
  const topUpFee = form.topUpServiceFeePct.trim() ? parseServiceFeePct(form.topUpServiceFeePct) : null;
  if (form.topUpServiceFeePct.trim() && topUpFee === null) {
    return fail(`La comisión del servicio en las recargas: ${SERVICE_FEE_RANGE}.`);
  }
  return ok({
    name,
    taxId,
    contactName: blankToNull(form.contactName),
    contactEmail: email,
    contactPhone: phone,
    notes,
    defaultPlatformCommissionBps: commission,
    defaultServiceFeeBps: serviceFee,
    defaultTopUpServiceFeeBps: topUpFee,
  });
}

/** Solo lo que cambia respecto a lo guardado (PATCH). Vacío = nada que guardar. */
type BusinessMoney = Pick<BusinessView, 'defaultPlatformCommissionBps'> &
  Partial<Pick<BusinessView, 'defaultServiceFeeBps' | 'defaultTopUpServiceFeeBps'>>;

const BUSINESS_MONEY: ReadonlyArray<{ key: keyof BusinessMoney; label: string; empty: string }> = [
  { key: 'defaultPlatformCommissionBps', label: 'comisión por defecto', empty: 'la general' },
  {
    key: 'defaultServiceFeeBps',
    label: 'comisión del servicio en los pagos con tarjeta',
    empty: `la de fábrica (${formatPercent(DEFAULT_SERVICE_FEE_BPS)})`,
  },
  {
    key: 'defaultTopUpServiceFeeBps',
    label: 'comisión del servicio en las recargas',
    empty: `la de fábrica (${formatPercent(DEFAULT_SERVICE_FEE_BPS)})`,
  },
];

/**
 * La frase del 2FA de un negocio: cada comisión por defecto que cambia («de →
 * a»), o al darlo de alta (`saved` null), las que se ponen.
 */
export function businessMoneyChanges(saved: BusinessMoney | null, dto: Partial<BusinessMoney>): string[] {
  return BUSINESS_MONEY.flatMap(({ key, label, empty }) => {
    const next = dto[key];
    const text = (bps: number | null | undefined) => (bps === null || bps === undefined ? empty : formatPercent(bps));
    if (saved === null) return next === null || next === undefined ? [] : [`${label}: ${text(next)}`];
    if (next === undefined || next === (saved[key] ?? null)) return [];
    return [`${label}: ${text(saved[key])} → ${text(next)}`];
  });
}

export function businessChanges(saved: BusinessView, next: BusinessFields): UpdateBusinessDto {
  const keys = Object.keys(next) as Array<keyof BusinessFields>;
  return keys.reduce<UpdateBusinessDto>((acc, key) => {
    const before = saved[key] ?? null;
    return before === next[key] ? acc : { ...acc, [key]: next[key] };
  }, {});
}

// ─── Local nuevo ────────────────────────────────────────────────────

export interface NewVenueForm {
  name: string;
  slug: string;
  timezone: string;
  businessId: string;
  walletGroup: string;
  commissionPct: string;
}

export const EMPTY_VENUE_FORM: NewVenueForm = {
  name: '',
  slug: '',
  timezone: 'Europe/Madrid',
  businessId: '',
  walletGroup: '',
  commissionPct: '',
};

/** "Luna Valencia" → "luna-valencia" (sin tildes ni signos). */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function newVenuePayload(form: NewVenueForm): FormResult<CreateVenueDto> {
  const name = form.name.trim();
  if (name.length < 2 || name.length > 80) return fail('El nombre del local, de 2 a 80 letras.');
  const slug = form.slug.trim() || slugFromName(name);
  if (slug.length < 2 || !SLUG.test(slug)) {
    return fail('El nombre corto (para la dirección): minúsculas y números separados por guiones (luna-vlc).');
  }
  const timezone = form.timezone.trim() || 'Europe/Madrid';
  if (!isValidTimeZone(timezone)) return fail('Zona horaria desconocida (por ejemplo Europe/Madrid).');
  const group = groupProblem(form.walletGroup);
  if (group) return fail(group);
  let commission: number | undefined;
  if (form.commissionPct.trim()) {
    const bps = parsePercentToBps(form.commissionPct);
    if (bps === null) return fail('La comisión: un porcentaje de 0 a 100.');
    commission = bps;
  }
  return ok({
    name,
    slug,
    timezone,
    ...(form.businessId ? { businessId: form.businessId } : {}),
    ...(form.walletGroup.trim() ? { walletGroup: form.walletGroup.trim() } : {}),
    ...(commission !== undefined ? { platformCommissionBps: commission } : {}),
  });
}

function groupProblem(raw: string): string | null {
  const group = raw.trim();
  if (!group) return null;
  if (group.length > 60 || !WALLET_GROUP.test(group)) {
    return 'El grupo del saldo: minúsculas, números, guion o guion bajo (por ejemplo grupo-luna).';
  }
  return null;
}

// ─── Perfil del local ───────────────────────────────────────────────

export interface ProfileForm {
  name: string;
  timezone: string;
  vatPct: string;
  vatRegime: string;
  /** Vacío = sin grupo (el saldo solo vale en este local). */
  walletGroup: string;
}

export function profileFormFrom(v: VenueDetail): ProfileForm {
  return {
    name: v.name,
    timezone: v.timezone,
    vatPct: bpsToPercentInput(v.vatBps),
    vatRegime: v.vatRegime,
    walletGroup: v.walletGroup ?? '',
  };
}

export type ProfileDto = Omit<UpdateVenueProfileDto, 'totpCode'>;

export interface ProfileChange {
  dto: ProfileDto;
  changes: string[];
  needsTotp: boolean;
}

export function profilePayload(saved: VenueDetail, form: ProfileForm): FormResult<ProfileChange> {
  const name = form.name.trim();
  if (name.length < 2 || name.length > 80) return fail('El nombre del local, de 2 a 80 letras.');
  const timezone = form.timezone.trim();
  if (!isValidTimeZone(timezone)) return fail('Zona horaria desconocida (por ejemplo Europe/Madrid).');
  const vatBps = parsePercentToBps(form.vatPct);
  if (vatBps === null) return fail('El IVA: un porcentaje de 0 a 100 (por ejemplo 21).');
  if (!(form.vatRegime in VAT_REGIME_LABELS)) return fail('Elige el régimen de IVA.');
  const group = groupProblem(form.walletGroup);
  if (group) return fail(group);
  const walletGroup = form.walletGroup.trim() || null;

  const dto: ProfileDto = {
    ...(name !== saved.name ? { name } : {}),
    ...(timezone !== saved.timezone ? { timezone } : {}),
    ...(vatBps !== saved.vatBps ? { vatBps } : {}),
    ...(form.vatRegime !== saved.vatRegime ? { vatRegime: form.vatRegime as ProfileDto['vatRegime'] } : {}),
    ...(walletGroup !== (saved.walletGroup ?? null) ? { walletGroup } : {}),
  };
  const changes = [
    dto.name !== undefined ? `nombre: ${saved.name} → ${name}` : null,
    dto.timezone !== undefined ? `zona horaria: ${saved.timezone} → ${timezone}` : null,
    dto.vatBps !== undefined ? `IVA: ${formatPercent(saved.vatBps)} → ${formatPercent(vatBps)}` : null,
    dto.vatRegime !== undefined
      ? `régimen de IVA: ${VAT_REGIME_LABELS[saved.vatRegime] ?? saved.vatRegime} → ${VAT_REGIME_LABELS[form.vatRegime]}`
      : null,
    dto.walletGroup !== undefined
      ? `grupo del saldo: ${saved.walletGroup ?? 'ninguno'} → ${walletGroup ?? 'ninguno'}`
      : null,
  ].filter((c): c is string => c !== null);
  if (changes.length === 0) return fail('No has cambiado nada.');
  return ok({ dto, changes, needsTotp: profileNeedsTotp(dto) });
}

// ─── Reglas del local ───────────────────────────────────────────────

type Categories = Record<keyof OperatorCommissionDefaults, string>;

export interface RulesForm {
  maxCobroEur: string;
  platformPct: string;
  categories: Categories;
  /** Vacío = lo general (PAYOUT_HOLD_DAYS). "0" = al cerrar la noche. */
  holdDays: string;
  refundThresholdEur: string;
  payoutRequiresApproval: boolean;
  /** «Comisión del servicio al cliente»: el interruptor y sus % (pagos con tarjeta / recargas). */
  serviceFeeEnabled: boolean;
  serviceFeePct: string;
  topUpServiceFeePct: string;
}

/** Lo guardado de la comisión del servicio (un local del API anterior: apagada y al 10 %). */
function savedServiceFee(r: VenueRules): { enabled: boolean; cardBps: number; topUpBps: number } {
  return {
    enabled: r.serviceFeeEnabled ?? false,
    cardBps: r.serviceFeeBps ?? DEFAULT_SERVICE_FEE_BPS,
    topUpBps: r.topUpServiceFeeBps ?? DEFAULT_SERVICE_FEE_BPS,
  };
}

export function rulesFormFrom(r: VenueRules): RulesForm {
  const categories = CATEGORY_KEYS.reduce<Categories>(
    // Entradas (sección nueva) no está guardada en los locales de antes: 0 %.
    (acc, key) => ({ ...acc, [key]: bpsToPercentInput(r.operatorCommissionDefaults[key] ?? 0) }),
    {} as Categories,
  );
  return {
    maxCobroEur: centsToInput(r.operatorMaxCobroCents),
    platformPct: bpsToPercentInput(r.platformCommissionBps),
    categories,
    holdDays: r.payoutHoldDays === null ? '' : String(r.payoutHoldDays),
    refundThresholdEur: centsToInput(r.refundApprovalThresholdCents),
    payoutRequiresApproval: r.payoutRequiresApproval,
    serviceFeeEnabled: savedServiceFee(r).enabled,
    serviceFeePct: bpsToPercentInput(savedServiceFee(r).cardBps),
    topUpServiceFeePct: bpsToPercentInput(savedServiceFee(r).topUpBps),
  };
}

export type RulesDto = Omit<UpdateVenueRulesDto, 'totpCode'>;

export interface RulesChange {
  dto: RulesDto;
  changes: string[];
}

interface ParsedRules {
  maxCobro: number;
  platform: number;
  categories: OperatorCommissionDefaults;
  holdDays: number | null;
  refundThreshold: number;
  serviceFeeBps: number;
  topUpServiceFeeBps: number;
}

function parseRules(form: RulesForm): FormResult<ParsedRules> {
  const maxCobro = parseEuroCents(form.maxCobroEur, MAX_OPERATOR_COBRO_CENTS);
  if (maxCobro === null) return fail('Tope por cobro: un importe de 0,01 € a 10.000 €.');
  const platform = parsePercentToBps(form.platformPct);
  if (platform === null) return fail('Comisión de la plataforma: un porcentaje de 0 a 100.');
  const categories = {} as OperatorCommissionDefaults;
  for (const key of CATEGORY_KEYS) {
    const bps = parsePercentToBps(form.categories[key]);
    if (bps === null) return fail(`${CATEGORY_LABELS[key]}: un porcentaje de 0 a 100.`);
    categories[key] = bps;
    if (bps + platform > 10_000) {
      return fail(
        `${CATEGORY_LABELS[key]}: ${formatPercent(bps)} más la plataforma (${formatPercent(platform)}) pasa del 100 %.`,
      );
    }
  }
  const daysText = form.holdDays.trim();
  const holdDays = daysText === '' ? null : /^\d{1,2}$/.test(daysText) ? Number(daysText) : NaN;
  if (holdDays !== null && !(holdDays >= 0 && holdDays <= MAX_VENUE_PAYOUT_HOLD_DAYS)) {
    return fail(`Días de espera: de 0 a ${MAX_VENUE_PAYOUT_HOLD_DAYS} (0 = se les paga al cerrar la noche).`);
  }
  const refundThreshold = parseCentsAllowZero(form.refundThresholdEur, MAX_OPERATOR_COBRO_CENTS);
  if (refundThreshold === null) return fail('Umbral de devolución: un importe de 0 € a 10.000 €.');
  const serviceFeeBps = parseServiceFeePct(form.serviceFeePct);
  if (serviceFeeBps === null) return fail(`Comisión del servicio en los pagos con tarjeta: ${SERVICE_FEE_RANGE}.`);
  const topUpServiceFeeBps = parseServiceFeePct(form.topUpServiceFeePct);
  if (topUpServiceFeeBps === null) return fail(`Comisión del servicio en las recargas: ${SERVICE_FEE_RANGE}.`);
  return ok({ maxCobro, platform, categories, holdDays, refundThreshold, serviceFeeBps, topUpServiceFeeBps });
}

const yesNo = (v: boolean): string => (v ? 'sí' : 'no');
const onOff = (v: boolean): string => (v ? 'encendida' : 'apagada');

/**
 * Reglas cambiadas (solo lo que cambia) y la lista para la confirmación.
 * `generalHoldDays`: los días de espera generales (PAYOUT_HOLD_DAYS) si se
 * saben; null = no se saben (el local tenía los suyos).
 */
export function rulesPayload(
  saved: VenueRules,
  form: RulesForm,
  generalHoldDays: number | null,
): FormResult<RulesChange> {
  const parsed = parseRules(form);
  if (!parsed.ok) return parsed;
  const p = parsed.value;
  const fee = savedServiceFee(saved);
  const changedCategories = CATEGORY_KEYS.filter((k) => p.categories[k] !== (saved.operatorCommissionDefaults[k] ?? 0));
  const holdText = (d: number | null): string =>
    d !== null
      ? holdDaysText(d).toLowerCase()
      : generalHoldDays === null
        ? 'lo general'
        : `lo general (${holdDaysText(generalHoldDays).toLowerCase()})`;

  const dto: RulesDto = {
    ...(p.maxCobro !== saved.operatorMaxCobroCents ? { operatorMaxCobroCents: p.maxCobro } : {}),
    ...(p.platform !== saved.platformCommissionBps ? { platformCommissionBps: p.platform } : {}),
    ...(changedCategories.length > 0
      ? { operatorCommissionDefaults: Object.fromEntries(changedCategories.map((k) => [k, p.categories[k]])) }
      : {}),
    ...(p.holdDays !== saved.payoutHoldDays ? { payoutHoldDays: p.holdDays } : {}),
    ...(p.refundThreshold !== saved.refundApprovalThresholdCents
      ? { refundApprovalThresholdCents: p.refundThreshold }
      : {}),
    ...(form.payoutRequiresApproval !== saved.payoutRequiresApproval
      ? { payoutRequiresApproval: form.payoutRequiresApproval }
      : {}),
    ...(form.serviceFeeEnabled !== fee.enabled ? { serviceFeeEnabled: form.serviceFeeEnabled } : {}),
    ...(p.serviceFeeBps !== fee.cardBps ? { serviceFeeBps: p.serviceFeeBps } : {}),
    ...(p.topUpServiceFeeBps !== fee.topUpBps ? { topUpServiceFeeBps: p.topUpServiceFeeBps } : {}),
  };

  const changes = [
    dto.operatorMaxCobroCents !== undefined
      ? `tope por cobro: ${formatEur(saved.operatorMaxCobroCents)} → ${formatEur(p.maxCobro)}`
      : null,
    dto.platformCommissionBps !== undefined
      ? `comisión de la plataforma: ${formatPercent(saved.platformCommissionBps)} → ${formatPercent(p.platform)}`
      : null,
    ...changedCategories.map(
      (k) =>
        `${CATEGORY_LABELS[k].toLowerCase()}: ${formatPercent(saved.operatorCommissionDefaults[k] ?? 0)} → ${formatPercent(p.categories[k] ?? 0)}`,
    ),
    dto.payoutHoldDays !== undefined
      ? `días de espera: ${holdText(saved.payoutHoldDays)} → ${holdText(p.holdDays)}`
      : null,
    dto.refundApprovalThresholdCents !== undefined
      ? `devolución con aprobación desde: ${formatEur(saved.refundApprovalThresholdCents)} → ${formatEur(p.refundThreshold)}`
      : null,
    dto.payoutRequiresApproval !== undefined
      ? `pagos a chicas con aprobación: ${yesNo(saved.payoutRequiresApproval)} → ${yesNo(form.payoutRequiresApproval)}`
      : null,
    dto.serviceFeeEnabled !== undefined
      ? `comisión del servicio al cliente: ${onOff(fee.enabled)} → ${onOff(form.serviceFeeEnabled)}`
      : null,
    dto.serviceFeeBps !== undefined
      ? `comisión del servicio en los pagos con tarjeta: ${formatPercent(fee.cardBps)} → ${formatPercent(p.serviceFeeBps)}`
      : null,
    dto.topUpServiceFeeBps !== undefined
      ? `comisión del servicio en las recargas: ${formatPercent(fee.topUpBps)} → ${formatPercent(p.topUpServiceFeeBps)}`
      : null,
  ].filter((c): c is string => c !== null);

  if (changes.length === 0) return fail('No has cambiado nada.');
  return ok({ dto, changes });
}

/** Días generales si el local usa los generales (si no, no se saben). */
export function generalHoldDaysOf(rules: VenueRules): number | null {
  return rules.payoutHoldDays === null ? rules.effectivePayoutHoldDays : null;
}

/** Umbral por defecto (100 €), para el texto de ayuda. */
export const DEFAULT_REFUND_THRESHOLD_TEXT = formatEur(DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS);
