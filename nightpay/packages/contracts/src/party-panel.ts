import { z } from 'zod';
import { ORGANIZER_OWN_BAR_BPS } from './party';

// ═══════════════════════════════════════════════════════════════════════
// OxioParty: el panel del organizador (EDITION=party; con 'club', 404).
//
//   GET /v1/party/live                 en directo: la noche (o una concreta) o la fiesta entera
//   GET /v1/party/cash-desk/me         el efectivo de la caja de quien lo pide (taquilla)
//   GET /v1/party/settlement           lo que se paga a cada caseta
//   GET /v1/party/settlement/sepa      las transferencias para el banco (pain.001.001.03)
//   GET /v1/party/settlement/csv       lo mismo en CSV
//
// Las noches van de las 08:00 a las 08:00 de Madrid (como el cierre
// automático de OxioPay): «la noche del 23» empieza el 23 a las 08:00.
// «La fiesta entera» es todo lo de esta instalación (cada fiesta va en la
// suya), también lo cargado desde casa antes de empezar.
//
// Qué es «vendido» (las reglas del mapa del dinero, sin contar dos veces):
// los cobros pagados que no son recargas + los consumos del saldo no
// anulados (pulsera, PIN, Face ID), con su propina y sin la «Comisión del
// servicio» (es de OxioPay), menos lo devuelto de esos cobros (sin la
// comisión devuelta). Las recargas son «cargado», nunca venta: lo que se
// vende con la pulsera ya cuenta en su consumo.
// ═══════════════════════════════════════════════════════════════════════

const DayRe = /^\d{4}-\d{2}-\d{2}$/;
/** AAAA-MM-DD que existe. */
export const PartyDaySchema = z
  .string()
  .regex(DayRe, 'Fecha AAAA-MM-DD')
  .refine((d) => new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'Esa fecha no existe');

// ─── En directo ─────────────────────────────────────────────────────────

/** El aviso «sin cobros desde hace N min»: de serie, 15. */
export const PARTY_IDLE_DEFAULT_MINUTES = 15;
export const PARTY_IDLE_MAX_MINUTES = 240;

export const PARTY_LIVE_SCOPES = ['night', 'event'] as const;
export type PartyLiveScope = (typeof PARTY_LIVE_SCOPES)[number];

export const PartyLiveQuerySchema = z.object({
  /** night: una noche (la de ahora o `night`); event: la fiesta entera. */
  scope: z.enum(PARTY_LIVE_SCOPES).default('night'),
  /** La noche que empieza ese día a las 08:00 (sin ella, la de ahora). Solo con scope=night. */
  night: PartyDaySchema.optional(),
  /** Minutos sin cobros para avisar de una caseta. */
  idleMin: z.coerce.number().int().min(1).max(PARTY_IDLE_MAX_MINUTES).default(PARTY_IDLE_DEFAULT_MINUTES),
});
export type PartyLiveQuery = z.infer<typeof PartyLiveQuerySchema>;

/** Una hora de ventas (vendido neto de esa hora; la que sigue abierta, `open`). */
export interface PartyHour {
  /** Inicio de la hora (ISO). */
  at: string;
  soldCents: number;
  open: boolean;
}

export interface PartyStallLive {
  /** null: lo vendido por quien no tiene caseta (es del organizador). */
  id: string | null;
  name: string;
  managerName: string | null;
  managerContact: string | null;
  /** Parte del organizador (bps); null sin caseta. */
  organizerBps: number | null;
  ownBar: boolean;
  active: boolean;
  soldCents: number;
  /** Cobros y consumos (las devoluciones restan dinero, no cobros). */
  count: number;
  /** Último cobro o consumo (ISO), o null. */
  lastAt: string | null;
  /** Sin cobros desde hace `idleMinutes` (solo en directo y con la fiesta en marcha). */
  idle: boolean;
}

export type PartyDeskKind = 'person' | 'terminal' | 'phone';

/** Una taquilla: una persona de recepción o un datáfono de recepción; y «Desde el móvil». */
export interface PartyDesk {
  /** `person:<id>`, `terminal:<id>` o `phone`. */
  key: string;
  kind: PartyDeskKind;
  name: string;
  /** Cargado en efectivo (sin la «Comisión del servicio»). */
  cashCents: number;
  /** Cargado con tarjeta (en taquilla o desde el móvil). */
  cardCents: number;
  /** Efectivo en su caja: lo cargado + la comisión del servicio en efectivo − el saldo devuelto en efectivo. */
  cashInDeskCents: number;
  count: number;
}

export type PartyAlert =
  | { kind: 'CASH_OVER'; deskKey: string; name: string; cashCents: number; thresholdCents: number }
  | { kind: 'STALL_IDLE'; stallId: string; name: string; minutes: number; managerName: string; managerContact: string | null };

export interface PartyNight {
  /** AAAA-MM-DD: la noche que empieza ese día a las 08:00. */
  day: string;
  current: boolean;
}

export interface PartyLive {
  scope: PartyLiveScope;
  /** La noche pedida (AAAA-MM-DD) o null (la fiesta entera). */
  night: string | null;
  from: string | null;
  to: string;
  generatedAt: string;
  /** La ventana llega hasta ahora: la última hora, los avisos y «en curso». */
  live: boolean;
  loaded: { totalCents: number; cashCents: number; cardCents: number; phoneCents: number; count: number };
  sold: { totalCents: number; count: number; refundedCents: number };
  /** Lo que se cargó y se vendió en la última hora (null si no es en directo). */
  lastHour: { loadedCents: number; soldCents: number } | null;
  /** Dinero aún en las pulseras: los saldos vivos, ahora. */
  inWristbandsCents: number;
  /** Pulseras con saldo o que ya han pagado algo. */
  activeWristbands: number;
  hourly: PartyHour[];
  /** Por lo vendido, de más a menos; «Sin caseta» al final si hay. */
  stalls: PartyStallLive[];
  desks: PartyDesk[];
  alerts: PartyAlert[];
  idleMinutes: number;
  cashAlertCents: number;
  event: { name: string; startsAt: string | null; endsAt: string | null; ended: boolean; nights: PartyNight[] };
}

// ─── La caja de la taquilla ─────────────────────────────────────────────

/** El efectivo de quien lo pide, en la noche de ahora (desde las 08:00 de Madrid). */
export interface PartyCashDesk {
  from: string;
  to: string;
  /** Recargas en efectivo cobradas (con su «Comisión del servicio»; las anulaciones restan). */
  cashInCents: number;
  topUpsCount: number;
  /** Saldo devuelto en efectivo por esta persona. */
  cashOutCents: number;
  payoutsCount: number;
  /** Lo que tiene que haber en su caja (sin el fondo). */
  cashCents: number;
  alertCents: number;
  overAlert: boolean;
}

// ─── Liquidación por caseta ─────────────────────────────────────────────

export const PartySettlementQuerySchema = z
  .object({
    /** Primera noche (AAAA-MM-DD, desde las 08:00 de ese día). */
    from: PartyDaySchema.optional(),
    /** Última noche (hasta las 08:00 del día siguiente). */
    to: PartyDaySchema.optional(),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), 'Pon las dos fechas o ninguna (la fiesta entera)')
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'La última noche es anterior a la primera');
export type PartySettlementQuery = z.infer<typeof PartySettlementQuerySchema>;

export type PartySettlementStatus = 'READY' | 'NO_IBAN' | 'OWN_BAR' | 'NOTHING';

export interface PartySettlementRow {
  /** null: lo vendido sin caseta (todo para el organizador). */
  stallId: string | null;
  name: string;
  managerName: string | null;
  soldCents: number;
  count: number;
  organizerBps: number;
  ownBar: boolean;
  /** round(vendido · bps / 10000). */
  organizerCents: number;
  /** vendido − parte del organizador. */
  toPayCents: number;
  hasIban: boolean;
  /** El IBAN tapado (ES91 •••• •••• 1332). */
  ibanMasked: string | null;
  /** READY: va en el fichero del banco; NO_IBAN: falta su IBAN; OWN_BAR: no se paga; NOTHING: nada que pagar. */
  status: PartySettlementStatus;
}

export interface PartySettlement {
  from: string | null;
  to: string;
  fromNight: string | null;
  toNight: string | null;
  generatedAt: string;
  eventName: string;
  rows: PartySettlementRow[];
  totals: {
    soldCents: number;
    organizerCents: number;
    toPayCents: number;
    /** Transferencias que van en el fichero del banco. */
    transfers: number;
    transfersCents: number;
    /** Casetas con algo que pagar y sin IBAN. */
    missingIban: number;
  };
  /** La cuenta del local (el deudor del fichero): la pone OxioPay. */
  debtor: { name: string; ibanMasked: string | null };
  /** Lo que sobró en las pulseras: cargado, devuelto del saldo y lo que aún queda. */
  wristbands: { loadedCents: number; refundedCents: number; leftCents: number };
}

/** El estado de una fila: con algo que pagar, IBAN; «barra propia» no se paga. */
export function settlementStatusOf(row: { ownBar: boolean; toPayCents: number; hasIban: boolean; stallId: string | null }): PartySettlementStatus {
  if (row.ownBar || row.stallId === null) return 'OWN_BAR';
  if (row.toPayCents <= 0) return 'NOTHING';
  return row.hasIban ? 'READY' : 'NO_IBAN';
}

/** La parte del organizador: round(vendido · bps / 10000), simétrico con los negativos. */
export function organizerShareCents(soldCents: number, organizerBps: number): number {
  const raw = (Math.abs(soldCents) * organizerBps) / ORGANIZER_OWN_BAR_BPS;
  const share = Math.round(raw);
  return soldCents < 0 && share !== 0 ? -share : share;
}

// ─── Ficheros SEPA ya descargados ───────────────────────────────────────

/**
 * Un fichero SEPA para el banco ya descargado antes (el del cierre con las
 * mismas noches; el de las devoluciones con alguna de las mismas
 * transferencias): 409 ALREADY_EXPORTED con cuándo y quién, salvo que se
 * pida otra vez a propósito (`?again=1`). Subirlo dos veces al banco paga
 * dos veces. Lo dice el registro (audit_events), sin tabla nueva.
 */
export const ALREADY_EXPORTED_CODE = 'ALREADY_EXPORTED';

/** Lo que trae el 409 ALREADY_EXPORTED además de `code` y el mensaje. */
export interface SepaAlreadyExported {
  /** Cuándo se descargó la última vez (ISO). */
  exportedAt: string;
  /** Quién (su nombre, o lo de antes de la @ de su correo); null si no se sabe. */
  exportedBy: string | null;
}
