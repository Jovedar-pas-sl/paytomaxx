'use client';

import { useId, type CSSProperties } from 'react';
import { Input, Select } from '@nightpay/ui';
import { payoutHolderRequired } from '@nightpay/contracts';
import type { PayoutMethod } from '@/lib/api';
import { needsPayoutConfirmation, type SavedPayout } from '@/lib/payout-address';
import { PAYOUT_HINTS, needsAddress, payoutFieldProblems, type PayoutValues } from './onboarding-payout';

export type { PayoutValues } from './onboarding-payout';

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

interface Props {
  values: PayoutValues;
  onChange: (next: PayoutValues) => void;
  /** Lo que ya tenía guardado: si no cambia, ni se repite ni se vuelve a comprobar. */
  saved: SavedPayout;
  /** Tras intentar guardar: se marcan los errores en cada campo. */
  showErrors: boolean;
  disabled: boolean;
}

/**
 * "Cómo quieres cobrar": método, dirección (comprobada según el método, con
 * las mismas reglas que el API) y etiqueta; en la transferencia internacional,
 * además, el banco, su SWIFT/BIC, el país y el titular; en el IBAN SEPA, el
 * titular.
 */
export function PayoutSection({ values, onChange, saved, showErrors, disabled }: Props) {
  const methodId = useId();
  const set = (patch: Partial<PayoutValues>) => onChange({ ...values, ...patch });
  const problems = showErrors ? payoutFieldProblems(values, saved) : {};
  const method = values.method;
  const withAddress = needsAddress(method);
  const mustConfirm = withAddress && method !== '' && needsPayoutConfirmation(method, values.address, saved.address);
  const hint = method ? PAYOUT_HINTS[method] : null;

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
          value={method}
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
        {method === 'MANUAL_CASH' && hint ? <p style={hintStyle}>{hint.hint}</p> : null}
      </div>
      {method ? (
        <>
          {withAddress && hint ? (
            <div style={{ marginTop: '0.75rem' }}>
              <Input
                label="Dirección / IBAN / Email / Teléfono según método"
                value={values.address}
                onChange={(e) => set({ address: e.target.value })}
                placeholder={hint.placeholder}
                hint={hint.hint}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                error={problems.address}
                disabled={disabled}
              />
            </div>
          ) : null}
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
                error={problems.confirm}
                disabled={disabled}
              />
            </div>
          ) : null}
          {method === 'WIRE_INTERNATIONAL' ? (
            <WireFields values={values} set={set} problems={problems} disabled={disabled} />
          ) : payoutHolderRequired(method) ? (
            <HolderField values={values} set={set} problems={problems} disabled={disabled} />
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

/** Transferencia internacional: sin estos datos el dueño no puede pagarle. */
function WireFields({
  values,
  set,
  problems,
  disabled,
}: {
  values: PayoutValues;
  set: (patch: Partial<PayoutValues>) => void;
  problems: ReturnType<typeof payoutFieldProblems>;
  disabled: boolean;
}) {
  return (
    <>
      <div style={{ marginTop: '0.75rem' }}>
        <Input
          label="Banco"
          value={values.bankName}
          onChange={(e) => set({ bankName: e.target.value })}
          placeholder="TBC Bank"
          error={problems.bankName}
          disabled={disabled}
        />
      </div>
      <div style={{ marginTop: '0.75rem' }}>
        <Input
          label="SWIFT/BIC del banco"
          value={values.swiftBic}
          onChange={(e) => set({ swiftBic: e.target.value })}
          placeholder="TBCBGE22"
          hint="8 u 11 letras y números: te lo da tu banco."
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          error={problems.swiftBic}
          disabled={disabled}
        />
      </div>
      <div style={{ marginTop: '0.75rem' }}>
        <Input
          label="País del banco (opcional)"
          value={values.country}
          onChange={(e) => set({ country: e.target.value })}
          placeholder="Georgia"
          disabled={disabled}
        />
      </div>
      <HolderField values={values} set={set} problems={problems} disabled={disabled} />
    </>
  );
}

/** El titular: el banco comprueba que cuadre con la cuenta (IBAN SEPA y transferencia internacional). */
function HolderField({ values, set, problems, disabled }: Parameters<typeof WireFields>[0]) {
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <Input
        label="Titular de la cuenta"
        value={values.accountHolder}
        onChange={(e) => set({ accountHolder: e.target.value })}
        placeholder="Nombre y apellidos como en el banco"
        autoComplete="off"
        maxLength={120}
        error={problems.accountHolder}
        disabled={disabled}
      />
    </div>
  );
}

const sectionHead: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-dim)',
  fontWeight: 500,
};

const selectLabel: CSSProperties = {
  display: 'block',
  fontSize: 'var(--np-fs-14)',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
  marginBottom: '0.4rem',
};

const hintStyle: CSSProperties = {
  margin: '0.4rem 0 0',
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-dim)',
};
