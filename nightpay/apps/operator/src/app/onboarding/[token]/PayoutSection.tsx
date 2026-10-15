'use client';

import { useId, type CSSProperties } from 'react';
import { Input, Select } from '@nightpay/ui';
import type { PayoutMethod } from '@/lib/api';
import {
  needsPayoutConfirmation,
  payoutAddressProblem,
  payoutChanged,
  type SavedPayout,
} from '@/lib/payout-address';

const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  USDT_TRC20: 'USDT en red Tron (recomendado, ~0.5€)',
  USDT_BEP20: 'USDT en red BSC (Binance Smart Chain)',
  USDC_POLY: 'USDC en red Polygon',
  USDC_SOL: 'USDC en red Solana',
  BINANCE_PAY_ID: 'Binance Pay ID (transferencia interna)',
  OKX_INTERNAL: 'OKX (transferencia interna)',
  BYBIT_INTERNAL: 'Bybit (transferencia interna)',
  FASTERPAY_EMAIL: 'FasterPay (email)',
  PAYQUICKER_EMAIL: 'PayQuicker (email)',
  HYPERWALLET_TOKEN: 'Hyperwallet',
  REVOLUT_TAG: 'Revolut (@tag)',
  PAYONEER_EMAIL: 'Payoneer (email)',
  SEPA_IBAN: 'Transferencia SEPA (IBAN)',
  WIRE_INTERNATIONAL: 'Transferencia internacional (SWIFT)',
  MERCADOPAGO_CVU: 'MercadoPago (CVU)',
  PIX_KEY: 'Pix (Brasil)',
  NEQUI_PHONE: 'Nequi (Colombia, teléfono)',
  DAVIPLATA_PHONE: 'Daviplata (Colombia, teléfono)',
  MANUAL_CASH: 'Efectivo en mano',
};

export interface PayoutValues {
  method: PayoutMethod | '';
  address: string;
  /** La dirección otra vez, si es nueva (una letra mal puesta manda el dinero a otro sitio). */
  confirm: string;
  label: string;
}

interface Props {
  values: PayoutValues;
  onChange: (next: PayoutValues) => void;
  /** Lo que ya tenía guardado: si no cambia, ni se repite ni se vuelve a comprobar. */
  saved: SavedPayout;
  /** Tras intentar guardar: se marcan los errores en cada campo. */
  showErrors: boolean;
  disabled: boolean;
}

/** "Cómo quieres cobrar": método, dirección (comprobada según el método) y etiqueta. */
export function PayoutSection({ values, onChange, saved, showErrors, disabled }: Props) {
  const methodId = useId();
  const set = (patch: Partial<PayoutValues>) => onChange({ ...values, ...patch });
  const changed = payoutChanged(values.method, values.address, saved);
  const addressProblem = showErrors && changed ? payoutAddressProblem(values.method, values.address) : null;
  const mustConfirm = needsPayoutConfirmation(values.method, values.address, saved.address);

  return (
    <section>
      <h2 style={sectionHead}>Cómo quieres cobrar (opcional)</h2>
      <p style={hintStyle}>
        Si ya sabes cómo quieres recibir tu dinero, dínoslo aquí. Si no, déjalo en blanco y el admin te ayuda.
      </p>
      <div style={{ marginTop: '0.5rem' }}>
        <label htmlFor={methodId} style={selectLabel}>
          Método
        </label>
        <Select
          id={methodId}
          value={values.method}
          onChange={(e) => set({ method: e.target.value as PayoutMethod | '' })}
          disabled={disabled}
        >
          <option value="">— No sé todavía —</option>
          {(Object.keys(PAYOUT_METHOD_LABELS) as PayoutMethod[]).map((m) => (
            <option key={m} value={m}>
              {PAYOUT_METHOD_LABELS[m]}
            </option>
          ))}
        </Select>
      </div>
      {values.method ? (
        <>
          <div style={{ marginTop: '0.75rem' }}>
            <Input
              label="Dirección / IBAN / Email / Teléfono según método"
              value={values.address}
              onChange={(e) => set({ address: e.target.value })}
              placeholder="TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              error={addressProblem ?? undefined}
              disabled={disabled}
            />
          </div>
          {mustConfirm ? (
            <div style={{ marginTop: '0.75rem' }}>
              <Input
                label="Repite la dirección para confirmarla"
                value={values.confirm}
                onChange={(e) => set({ confirm: e.target.value })}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                hint="Tiene que ser exactamente la misma: si hay una letra mal, el dinero no te llega."
                disabled={disabled}
              />
            </div>
          ) : null}
          <div style={{ marginTop: '0.75rem' }}>
            <Input
              label="Etiqueta (opcional, para que el admin sepa de qué wallet hablas)"
              value={values.label}
              onChange={(e) => set({ label: e.target.value })}
              placeholder="Mi Binance principal"
              disabled={disabled}
            />
          </div>
        </>
      ) : null}
    </section>
  );
}

const sectionHead: CSSProperties = {
  margin: 0,
  fontSize: '0.78rem',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--np-text-dim)',
  fontWeight: 500,
};

const selectLabel: CSSProperties = {
  display: 'block',
  fontSize: '0.85rem',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
  marginBottom: '0.4rem',
};

const hintStyle: CSSProperties = {
  margin: '0.4rem 0 0',
  fontSize: '0.78rem',
  color: 'var(--np-text-dim)',
};
