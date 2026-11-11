'use client';

import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Input, Select } from '@nightpay/ui';
import type { PayoutMetadata, PayoutMethod } from '@/lib/api';
import { payoutAddressError, payoutValue, type PayoutValue } from '@/lib/payout-address';

/** Etiquetas humanas por método. */
export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  USDT_TRC20: 'USDT — Tron (TRC20) · default Binance',
  USDT_BEP20: 'USDT — Binance Smart Chain (BEP20)',
  USDC_POLY: 'USDC — Polygon',
  USDC_SOL: 'USDC — Solana',
  BINANCE_PAY_ID: 'Binance Pay ID (transferencia interna)',
  OKX_INTERNAL: 'OKX UID (transferencia interna)',
  BYBIT_INTERNAL: 'Bybit UID (transferencia interna)',
  FASTERPAY_EMAIL: 'FasterPay (email)',
  PAYQUICKER_EMAIL: 'PayQuicker (email)',
  HYPERWALLET_TOKEN: 'Hyperwallet (PayPal · token)',
  REVOLUT_TAG: 'Revolut (@tag o teléfono)',
  PAYONEER_EMAIL: 'Payoneer (email)',
  SEPA_IBAN: 'IBAN europeo (SEPA)',
  WIRE_INTERNATIONAL: 'Wire internacional (SWIFT — Georgia, Belize, etc.)',
  MERCADOPAGO_CVU: 'MercadoPago (CVU/CBU)',
  PIX_KEY: 'Pix (Brasil)',
  NEQUI_PHONE: 'Nequi (Colombia · teléfono)',
  DAVIPLATA_PHONE: 'Daviplata (Colombia · teléfono)',
  MANUAL_CASH: 'Efectivo (registro contable)',
};

/** Nombre corto para tablas. */
export const PAYOUT_METHOD_SHORT: Record<PayoutMethod, string> = {
  USDT_TRC20: 'USDT TRC20',
  USDT_BEP20: 'USDT BEP20',
  USDC_POLY: 'USDC Polygon',
  USDC_SOL: 'USDC Solana',
  BINANCE_PAY_ID: 'Binance Pay',
  OKX_INTERNAL: 'OKX',
  BYBIT_INTERNAL: 'Bybit',
  FASTERPAY_EMAIL: 'FasterPay',
  PAYQUICKER_EMAIL: 'PayQuicker',
  HYPERWALLET_TOKEN: 'Hyperwallet',
  REVOLUT_TAG: 'Revolut',
  PAYONEER_EMAIL: 'Payoneer',
  SEPA_IBAN: 'SEPA',
  WIRE_INTERNATIONAL: 'Wire',
  MERCADOPAGO_CVU: 'MercadoPago',
  PIX_KEY: 'Pix',
  NEQUI_PHONE: 'Nequi',
  DAVIPLATA_PHONE: 'Daviplata',
  MANUAL_CASH: 'Efectivo',
};

/** Grupos para el select agrupado. */
export const PAYOUT_METHOD_GROUPS: Array<{ label: string; methods: PayoutMethod[] }> = [
  { label: 'Cripto on-chain (verificación automática)', methods: ['USDT_TRC20', 'USDT_BEP20', 'USDC_POLY', 'USDC_SOL'] },
  { label: 'Exchange (transferencia interna)', methods: ['BINANCE_PAY_ID', 'OKX_INTERNAL', 'BYBIT_INTERNAL'] },
  { label: 'E-wallet internacional', methods: ['FASTERPAY_EMAIL', 'PAYQUICKER_EMAIL', 'HYPERWALLET_TOKEN', 'REVOLUT_TAG', 'PAYONEER_EMAIL'] },
  { label: 'Banco', methods: ['SEPA_IBAN', 'WIRE_INTERNATIONAL'] },
  { label: 'Wallets LatAm locales', methods: ['MERCADOPAGO_CVU', 'PIX_KEY', 'NEQUI_PHONE', 'DAVIPLATA_PHONE'] },
  { label: 'Otros', methods: ['MANUAL_CASH'] },
];

/** Las <optgroup> de métodos, opcionalmente filtradas. */
export function PayoutMethodOptions({ include }: { include?: (m: PayoutMethod) => boolean }) {
  return (
    <>
      {PAYOUT_METHOD_GROUPS.map((group) => {
        const methods = include ? group.methods.filter(include) : group.methods;
        if (methods.length === 0) return null;
        return (
          <optgroup key={group.label} label={group.label}>
            {methods.map((m) => (
              <option key={m} value={m}>
                {PAYOUT_METHOD_LABELS[m]}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

/** Placeholder + ayuda contextual por método. */
const METHOD_HINTS: Record<PayoutMethod, { placeholder: string; hint: string }> = {
  USDT_TRC20: { placeholder: 'TXY...', hint: 'Address Tron, 34 caracteres empezando por T.' },
  USDT_BEP20: { placeholder: '0x...', hint: 'Address EVM, 42 caracteres empezando por 0x.' },
  USDC_POLY: { placeholder: '0x...', hint: 'Address EVM Polygon, 42 caracteres empezando por 0x.' },
  USDC_SOL: { placeholder: 'Solana address (~44 chars)', hint: 'Address Solana base58.' },
  BINANCE_PAY_ID: { placeholder: '123456789', hint: 'Binance Pay ID (número en Binance app → Pay).' },
  OKX_INTERNAL: { placeholder: 'OKX UID', hint: 'OKX UID (número de 10 dígitos).' },
  BYBIT_INTERNAL: { placeholder: 'Bybit UID', hint: 'Bybit UID (8-10 dígitos).' },
  FASTERPAY_EMAIL: { placeholder: 'ana@ejemplo.com', hint: 'Email registrado en FasterPay.' },
  PAYQUICKER_EMAIL: { placeholder: 'ana@ejemplo.com', hint: 'Email registrado en PayQuicker.' },
  HYPERWALLET_TOKEN: { placeholder: 'usr-...', hint: 'Token de usuario Hyperwallet.' },
  REVOLUT_TAG: { placeholder: '@ana123 o +34...', hint: 'Tag Revolut o teléfono asociado.' },
  PAYONEER_EMAIL: { placeholder: 'ana@ejemplo.com', hint: 'Email registrado en Payoneer.' },
  SEPA_IBAN: { placeholder: 'ES12 3456 ...', hint: 'IBAN europeo SEPA (se comprueba el dígito de control).' },
  WIRE_INTERNATIONAL: { placeholder: 'GE12 NB12 0000 ...', hint: 'IBAN o número cuenta + completar bank name + SWIFT abajo.' },
  MERCADOPAGO_CVU: { placeholder: '0000003100012345678901', hint: 'CVU MercadoPago Argentina (22 dígitos) o CBU.' },
  PIX_KEY: { placeholder: '+55 11 99999-9999 / CPF / email', hint: 'Clave Pix (teléfono, CPF, email o random key).' },
  NEQUI_PHONE: { placeholder: '+57 300 ...', hint: 'Teléfono asociado a Nequi.' },
  DAVIPLATA_PHONE: { placeholder: '+57 300 ...', hint: 'Teléfono asociado a Daviplata.' },
  MANUAL_CASH: { placeholder: 'Notas internas', hint: 'No requiere address. Notas opcionales para el contable.' },
};

interface Props {
  /** Método actual (puede ser null si la chica aún no lo configuró). */
  method: PayoutMethod | null;
  address: string | null;
  metadata: PayoutMetadata | null;
  label: string | null;
  /** Valor ya limpio (ver payoutValue): dirección normalizada, sin campos vacíos. */
  onChange: (next: PayoutValue) => void;
  disabled?: boolean;
}

export function PayoutMethodForm({ method, address, metadata, label, onChange, disabled }: Props) {
  const selectId = useId();
  const [localMethod, setLocalMethod] = useState<PayoutMethod | ''>(method ?? '');
  const [localAddress, setLocalAddress] = useState(address ?? '');
  const [localLabel, setLocalLabel] = useState(label ?? '');
  const [bankName, setBankName] = useState(metadata?.bankName ?? '');
  const [swiftBic, setSwiftBic] = useState(metadata?.swiftBic ?? '');
  const [country, setCountry] = useState(metadata?.country ?? '');
  const [accountHolder, setAccountHolder] = useState(metadata?.accountHolder ?? '');

  // Propaga cambios al padre cada vez que el usuario edita.
  useEffect(() => {
    onChange(
      payoutValue(localMethod === '' ? null : localMethod, localAddress, localLabel, {
        bankName,
        swiftBic,
        country,
        accountHolder,
      }),
    );
  }, [localMethod, localAddress, localLabel, bankName, swiftBic, country, accountHolder]);

  const showAddress = localMethod !== '' && localMethod !== 'MANUAL_CASH';
  const showWireExtra = localMethod === 'WIRE_INTERNATIONAL';
  const hint = localMethod ? METHOD_HINTS[localMethod] : null;
  // Se avisa en cuanto hay algo escrito que no vale (vacío se avisa al guardar).
  const addressError =
    showAddress && localAddress.trim() ? payoutAddressError(localMethod || null, localAddress) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div>
        <label htmlFor={selectId} style={labelStyle}>
          Método de payout
        </label>
        <Select
          id={selectId}
          value={localMethod}
          onChange={(e) => setLocalMethod(e.target.value as PayoutMethod | '')}
          disabled={disabled}
        >
          <option value="">— No configurado —</option>
          <PayoutMethodOptions />
        </Select>
      </div>

      {showAddress && hint ? (
        <Input
          label="Address / Email / Teléfono / IBAN"
          value={localAddress}
          onChange={(e) => setLocalAddress(e.target.value)}
          placeholder={hint.placeholder}
          hint={hint.hint}
          error={addressError ?? undefined}
          aria-invalid={addressError ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
      ) : null}

      {showWireExtra ? (
        <>
          <Input
            label="Banco"
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
            placeholder="TBC Bank"
            disabled={disabled}
          />
          <Input
            label="SWIFT/BIC"
            value={swiftBic}
            onChange={(e) => setSwiftBic(e.target.value)}
            placeholder="TBCBGE22"
            disabled={disabled}
          />
          <Input
            label="País del banco"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder="Georgia"
            disabled={disabled}
          />
          <Input
            label="Titular cuenta"
            value={accountHolder}
            onChange={(e) => setAccountHolder(e.target.value)}
            placeholder="Camila Rodriguez"
            disabled={disabled}
          />
        </>
      ) : null}

      {localMethod !== '' ? (
        <Input
          label="Alias (opcional, para tu memoria)"
          value={localLabel}
          onChange={(e) => setLocalLabel(e.target.value)}
          placeholder='"Binance Ana", "TBC Camila", etc.'
          maxLength={120}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.875rem',
  fontWeight: 400,
  color: 'var(--np-text-mute)',
  marginBottom: '0.375rem',
};
