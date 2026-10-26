import {
  normalizePayoutAddress,
  normalizeWireDetails,
  payoutFormatProblem,
  wireDetailsProblems,
  type PayoutMetadata,
  type PayoutMethod,
} from '@nightpay/contracts';
import { needsPayoutConfirmation, payoutChanged, type SavedPayout } from '../../../lib/payout-address';

/**
 * «Cómo quieres cobrar» en el alta por enlace: cada método con su forma (las
 * mismas reglas que el API: payoutFormatProblem) y, en la transferencia
 * internacional, los datos del banco. Lógica pura (onboarding-payout.test.ts).
 */

export interface PayoutValues {
  method: PayoutMethod | '';
  address: string;
  /** La dirección otra vez, si es nueva (una letra mal puesta manda el dinero a otro sitio). */
  confirm: string;
  label: string;
  /** Transferencia internacional (SWIFT): los datos del banco. */
  bankName: string;
  swiftBic: string;
  country: string;
  accountHolder: string;
}

export const EMPTY_PAYOUT: PayoutValues = {
  method: '',
  address: '',
  confirm: '',
  label: '',
  bankName: '',
  swiftBic: '',
  country: '',
  accountHolder: '',
};

export type PayoutField = 'address' | 'confirm' | 'bankName' | 'swiftBic' | 'accountHolder';

/** El efectivo en mano no lleva dirección. */
export function needsAddress(method: PayoutMethod | ''): boolean {
  return method !== '' && method !== 'MANUAL_CASH';
}

function wireOf(v: PayoutValues): PayoutMetadata {
  return { bankName: v.bankName, swiftBic: v.swiftBic, country: v.country, accountHolder: v.accountHolder };
}

/**
 * Qué está mal en cada campo. Sin método («No sé todavía») o sin cambios
 * respecto a lo guardado, nada (una cuenta antigua no bloquea el resto).
 */
export function payoutFieldProblems(v: PayoutValues, saved: SavedPayout): Partial<Record<PayoutField, string>> {
  if (!v.method || !payoutChanged(v.method, v.address, saved)) return {};
  const problems: Partial<Record<PayoutField, string>> = {};
  if (needsAddress(v.method)) {
    const address = v.address.trim();
    const problem = address ? payoutFormatProblem(v.method, address) : 'Falta la dirección o la cuenta para este método';
    if (problem) problems.address = problem;
    else if (
      needsPayoutConfirmation(v.method, v.address, saved.address) &&
      normalizePayoutAddress(v.method, v.confirm) !== normalizePayoutAddress(v.method, v.address)
    ) {
      problems.confirm = 'Las dos direcciones no coinciden: revísalas';
    }
  }
  if (v.method === 'WIRE_INTERNATIONAL') {
    for (const p of wireDetailsProblems(wireOf(v))) problems[p.field] = p.message;
  }
  return problems;
}

const FIELD_ORDER: readonly PayoutField[] = ['address', 'confirm', 'bankName', 'swiftBic', 'accountHolder'];

/** Lo primero que impide guardar (null si nada). */
export function payoutProblem(v: PayoutValues, saved: SavedPayout): string | null {
  const problems = payoutFieldProblems(v, saved);
  return FIELD_ORDER.map((f) => problems[f]).find(Boolean) ?? null;
}

export interface PayoutDto {
  payoutMethod: PayoutMethod | null;
  payoutAddress: string | null;
  payoutLabel: string | null;
  payoutMetadata?: PayoutMetadata;
}

/**
 * Lo que se manda al API: «No sé todavía» sin dirección ni etiqueta; el
 * efectivo, sin dirección; el IBAN junto; el SWIFT con sus datos limpios.
 */
export function payoutDto(v: PayoutValues): PayoutDto {
  if (!v.method) return { payoutMethod: null, payoutAddress: null, payoutLabel: null };
  const dto: PayoutDto = {
    payoutMethod: v.method,
    payoutAddress: needsAddress(v.method) ? normalizePayoutAddress(v.method, v.address) || null : null,
    payoutLabel: v.label.trim() || null,
  };
  const wire = v.method === 'WIRE_INTERNATIONAL' ? normalizeWireDetails(wireOf(v)) : null;
  return wire ? { ...dto, payoutMetadata: wire } : dto;
}

/** Qué poner en la dirección según el método (antes salía una de Tron de ejemplo para todos). */
export const PAYOUT_HINTS: Record<PayoutMethod, { placeholder: string; hint: string }> = {
  USDT_TRC20: { placeholder: 'TXYZ…', hint: 'Tu dirección de USDT en red Tron: empieza por T y tiene 34 caracteres.' },
  USDT_BEP20: { placeholder: '0x…', hint: 'Tu dirección de USDT en red BSC: empieza por 0x y tiene 42 caracteres.' },
  USDC_POLY: { placeholder: '0x…', hint: 'Tu dirección de USDC en red Polygon: empieza por 0x y tiene 42 caracteres.' },
  USDC_SOL: { placeholder: 'Dirección de Solana', hint: 'Tu dirección de USDC en red Solana (unos 44 caracteres).' },
  BINANCE_PAY_ID: { placeholder: '123456789', hint: 'Tu Binance Pay ID: son números, lo ves en Binance → Pay.' },
  OKX_INTERNAL: { placeholder: 'UID de OKX', hint: 'Tu UID de OKX (números), o el email o el teléfono de tu cuenta.' },
  BYBIT_INTERNAL: { placeholder: 'UID de Bybit', hint: 'Tu UID de Bybit (números), o el email o el teléfono de tu cuenta.' },
  FASTERPAY_EMAIL: { placeholder: 'ana@ejemplo.com', hint: 'El email de tu cuenta de FasterPay.' },
  PAYQUICKER_EMAIL: { placeholder: 'ana@ejemplo.com', hint: 'El email de tu cuenta de PayQuicker.' },
  HYPERWALLET_TOKEN: { placeholder: 'usr-…', hint: 'Tu token de Hyperwallet (empieza por usr-) o el email de tu cuenta.' },
  REVOLUT_TAG: { placeholder: '@ana123', hint: 'Tu @tag de Revolut o el teléfono de tu cuenta.' },
  PAYONEER_EMAIL: { placeholder: 'ana@ejemplo.com', hint: 'El email de tu cuenta de Payoneer.' },
  SEPA_IBAN: { placeholder: 'ES12 3456 7890 1234 5678 9012', hint: 'Tu IBAN (se comprueba el dígito de control).' },
  WIRE_INTERNATIONAL: {
    placeholder: 'GE29 NB00 0000 0101 9049 17',
    hint: 'Tu IBAN o número de cuenta. Debajo, el banco, su SWIFT/BIC y el titular.',
  },
  MERCADOPAGO_CVU: { placeholder: '0000003100012345678901', hint: 'Tu CVU o CBU (22 números) o tu alias.' },
  PIX_KEY: { placeholder: 'CPF, +55…, email o clave aleatoria', hint: 'Tu clave Pix: CPF, teléfono, email o la clave aleatoria.' },
  NEQUI_PHONE: { placeholder: '+57 300 123 4567', hint: 'El móvil de Colombia de tu cuenta Nequi.' },
  DAVIPLATA_PHONE: { placeholder: '+57 300 123 4567', hint: 'El móvil de Colombia de tu cuenta Daviplata.' },
  MANUAL_CASH: { placeholder: '', hint: 'Te pagan en mano: no hace falta dirección.' },
};
