'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Logo, Select } from '@nightpay/ui';
import {
  fetchSelfOnboardingProfile,
  submitSelfOnboarding,
  type PayoutMethod,
  type SelfOnboardingProfile,
  type SelfOnboardingSubmitDto,
  type WalletProvider,
  type WalletStatusKYC,
} from '@/lib/api';

const LATAM_COUNTRIES = [
  'Argentina', 'Bolivia', 'Brasil', 'Chile', 'Colombia',
  'Cuba', 'Ecuador', 'El Salvador', 'Guatemala', 'Honduras',
  'México', 'Nicaragua', 'Panamá', 'Paraguay', 'Perú',
  'Puerto Rico', 'República Dominicana', 'Uruguay', 'Venezuela',
];

const WALLET_PROVIDER_LABELS: Record<WalletProvider, string> = {
  BINANCE: 'Binance (recomendado)',
  BYBIT: 'Bybit',
  OKX: 'OKX',
  CRYPTO_COM: 'Crypto.com',
  TRUST_WALLET: 'Trust Wallet (self-custody)',
  FASTERPAY: 'FasterPay (e-wallet, no cripto)',
  PAYQUICKER: 'PayQuicker (e-wallet, no cripto)',
  WISE: 'Wise',
  REVOLUT: 'Revolut',
  OTHER: 'Otro (cuéntame en notas)',
  NONE: 'Aún no tengo',
};

const WALLET_STATUS_LABELS: Record<WalletStatusKYC, string> = {
  NOT_STARTED: '🔴 No he empezado',
  REGISTERED: '🟡 Registrada, falta KYC',
  KYC_PENDING: '🟠 KYC enviado, esperando',
  KYC_VERIFIED: '🟢 KYC aprobado, todo OK',
  KYC_REJECTED: '⛔ KYC rechazado',
};

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
  token: string;
}

export function SelfOnboardingClient({ token }: Props) {
  const [profile, setProfile] = useState<SelfOnboardingProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Form state
  const [phone, setPhone] = useState('');
  const [passportCountry, setPassportCountry] = useState('');
  const [passportLast4, setPassportLast4] = useState('');
  const [hasEmpadronamiento, setHasEmpadronamiento] = useState(false);
  const [hasNie, setHasNie] = useState(false);
  const [hasTie, setHasTie] = useState(false);
  const [walletProvider, setWalletProvider] = useState<WalletProvider | ''>('');
  const [walletStatus, setWalletStatus] = useState<WalletStatusKYC | ''>('');
  const [walletTestPassed, setWalletTestPassed] = useState(false);
  const [needsHelpWallet, setNeedsHelpWallet] = useState(false);
  const [needsHelpDocs, setNeedsHelpDocs] = useState(false);
  const [notes, setNotes] = useState('');
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod | ''>('');
  const [payoutAddress, setPayoutAddress] = useState('');
  const [payoutLabel, setPayoutLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchSelfOnboardingProfile(token)
      .then((p) => {
        setProfile(p);
        setPhone(p.phone ?? '');
        setPassportCountry(p.passportCountry ?? '');
        setPassportLast4(p.passportLast4 ?? '');
        setHasEmpadronamiento(p.hasEmpadronamiento);
        setHasNie(p.hasNie);
        setHasTie(p.hasTie);
        setWalletProvider(p.walletProvider ?? '');
        setWalletStatus(p.walletStatus ?? '');
        setWalletTestPassed(p.walletTestPassed);
        setNeedsHelpWallet(p.needsHelpWallet);
        setNeedsHelpDocs(p.needsHelpDocs);
        setNotes(p.onboardingNotes ?? '');
        setPayoutMethod(p.payoutMethod ?? '');
        setPayoutAddress(p.payoutAddress ?? '');
        setPayoutLabel(p.payoutLabel ?? '');
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const dto: SelfOnboardingSubmitDto = {
        phone: phone.trim() || null,
        passportCountry: passportCountry || null,
        passportLast4: passportLast4.trim() || null,
        hasEmpadronamiento,
        hasNie,
        hasTie,
        walletProvider: walletProvider === '' ? null : walletProvider,
        walletStatus: walletStatus === '' ? null : walletStatus,
        walletTestPassed,
        needsHelpWallet,
        needsHelpDocs,
        onboardingNotes: notes.trim() || null,
        payoutMethod: payoutMethod === '' ? null : payoutMethod,
        payoutAddress: payoutAddress.trim() || null,
        payoutLabel: payoutLabel.trim() || null,
      };
      await submitSelfOnboarding(token, dto);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <main className="np-screen" style={pageStyle}>Cargando tu perfil…</main>;
  }
  if (error && !profile) {
    return (
      <main className="np-screen" style={pageStyle}>
        <Card style={{ ...cardStyle, textAlign: 'center', borderColor: 'var(--np-danger)' }}>
          <Logo height="2rem" />
          <h1 style={{ marginTop: '1rem', color: 'var(--np-danger)' }}>Link inválido</h1>
          <p style={{ color: 'var(--np-text-mute)', marginTop: '0.5rem' }}>{error}</p>
          <p style={{ fontSize: '0.85rem', color: 'var(--np-text-dim)', marginTop: '1rem' }}>
            Pídele al admin del local un link nuevo.
          </p>
        </Card>
      </main>
    );
  }
  if (done) {
    return (
      <main className="np-screen" style={pageStyle}>
        <Card style={{ ...cardStyle, textAlign: 'center', borderColor: 'var(--np-success)' }}>
          <Logo height="2rem" />
          <h1 style={{ marginTop: '1rem', color: 'var(--np-success)', fontSize: '1.5rem' }}>✓ Guardado</h1>
          <p style={{ color: 'var(--np-text-mute)', marginTop: '0.75rem' }}>
            Hemos recibido tus datos. Si necesitas cambiarlos, pídele al admin un link nuevo.
          </p>
          <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--np-text-dim)' }}>
            Ya puedes cerrar esta página.
          </p>
        </Card>
      </main>
    );
  }
  if (!profile) return null;

  return (
    <main className="np-screen" style={pageStyle}>
      <header style={headerStyle}>
        <Logo height="2rem" />
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--np-text-mute)' }}>
          {profile.venueName}
        </p>
      </header>

      <Card style={cardStyle}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 600, letterSpacing: '-0.02em' }}>
          Tu perfil
        </h1>
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: 'var(--np-text-mute)' }}>
          Hola{profile.displayName ? `, ${profile.displayName}` : ''} 👋. Esta página es para que
          rellenes tu información (pasaporte, wallet, docs). Te ahorra que tu admin te lo pregunte.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: '1.5rem' }}>
          {/* Datos personales */}
          <section>
            <h2 style={sectionHead}>Datos personales</h2>
            <Input
              label="Móvil"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+34 6XX XX XX XX"
              disabled={submitting}
              type="tel"
              inputMode="tel"
            />
            <div style={{ marginTop: '0.75rem' }}>
              <label style={selectLabel}>País del pasaporte</label>
              <Select
                value={passportCountry}
                onChange={(e) => setPassportCountry(e.target.value)}
                disabled={submitting}
              >
                <option value="">— Selecciona tu país —</option>
                {LATAM_COUNTRIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
                <option value="Otro">Otro (no de LatAm)</option>
              </Select>
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <Input
                label="Últimos 4 dígitos del pasaporte"
                value={passportLast4}
                onChange={(e) => setPassportLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="8742"
                maxLength={4}
                disabled={submitting}
                inputMode="numeric"
              />
              <p style={hintStyle}>
                Solo los últimos 4 — no guardamos tu pasaporte completo.
              </p>
            </div>
          </section>

          {/* Docs España */}
          <section>
            <h2 style={sectionHead}>Documentos que tienes</h2>
            <CheckBoxRow
              checked={hasEmpadronamiento}
              onChange={setHasEmpadronamiento}
              disabled={submitting}
              title="Empadronamiento"
              description="Padrón municipal. Sirve para abrir Wise/Revolut a veces."
            />
            <CheckBoxRow
              checked={hasNie}
              onChange={setHasNie}
              disabled={submitting}
              title="NIE"
              description="Número de Identidad de Extranjero."
            />
            <CheckBoxRow
              checked={hasTie}
              onChange={setHasTie}
              disabled={submitting}
              title="TIE"
              description="Tarjeta de residencia legal."
            />
          </section>

          {/* Wallet */}
          <section>
            <h2 style={sectionHead}>Wallet / Exchange donde recibir tu dinero</h2>
            <div style={{ marginTop: '0.5rem' }}>
              <label style={selectLabel}>¿Dónde tienes tu wallet?</label>
              <Select
                value={walletProvider}
                onChange={(e) => setWalletProvider(e.target.value as WalletProvider | '')}
                disabled={submitting}
              >
                <option value="">— Aún no decidido —</option>
                {(Object.keys(WALLET_PROVIDER_LABELS) as WalletProvider[]).map((p) => (
                  <option key={p} value={p}>{WALLET_PROVIDER_LABELS[p]}</option>
                ))}
              </Select>
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <label style={selectLabel}>¿Cómo va el KYC?</label>
              <Select
                value={walletStatus}
                onChange={(e) => setWalletStatus(e.target.value as WalletStatusKYC | '')}
                disabled={submitting}
              >
                <option value="">— No aplica todavía —</option>
                {(Object.keys(WALLET_STATUS_LABELS) as WalletStatusKYC[]).map((s) => (
                  <option key={s} value={s}>{WALLET_STATUS_LABELS[s]}</option>
                ))}
              </Select>
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <CheckBoxRow
                checked={walletTestPassed}
                onChange={setWalletTestPassed}
                disabled={submitting}
                title="Recibí la prueba de 1 USDT"
                description="Marca cuando el admin te haya enviado 1 USDT de prueba y lo veas en tu wallet."
              />
            </div>
          </section>

          {/* Método de payout */}
          <section>
            <h2 style={sectionHead}>Cómo quieres cobrar (opcional)</h2>
            <p style={hintStyle}>
              Si ya sabes cómo quieres recibir tu dinero, dínoslo aquí. Si no, déjalo en blanco
              y el admin te ayuda.
            </p>
            <div style={{ marginTop: '0.5rem' }}>
              <label style={selectLabel}>Método</label>
              <Select
                value={payoutMethod}
                onChange={(e) => setPayoutMethod(e.target.value as PayoutMethod | '')}
                disabled={submitting}
              >
                <option value="">— No sé todavía —</option>
                {(Object.keys(PAYOUT_METHOD_LABELS) as PayoutMethod[]).map((m) => (
                  <option key={m} value={m}>{PAYOUT_METHOD_LABELS[m]}</option>
                ))}
              </Select>
            </div>
            {payoutMethod ? (
              <>
                <div style={{ marginTop: '0.75rem' }}>
                  <Input
                    label="Dirección / IBAN / Email / Teléfono según método"
                    value={payoutAddress}
                    onChange={(e) => setPayoutAddress(e.target.value)}
                    placeholder="TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV"
                    disabled={submitting}
                  />
                </div>
                <div style={{ marginTop: '0.75rem' }}>
                  <Input
                    label="Etiqueta (opcional, para que el admin sepa de qué wallet hablas)"
                    value={payoutLabel}
                    onChange={(e) => setPayoutLabel(e.target.value)}
                    placeholder="Mi Binance principal"
                    disabled={submitting}
                  />
                </div>
              </>
            ) : null}
          </section>

          {/* Ayuda */}
          <section>
            <h2 style={sectionHead}>¿Necesitas ayuda?</h2>
            <CheckBoxRow
              checked={needsHelpWallet}
              onChange={setNeedsHelpWallet}
              disabled={submitting}
              title="Sí, ayuda con la wallet"
              description="No sé abrir Binance, no entiendo cripto, mi KYC fue rechazado."
              warn
            />
            <CheckBoxRow
              checked={needsHelpDocs}
              onChange={setNeedsHelpDocs}
              disabled={submitting}
              title="Sí, ayuda con la documentación"
              description="Trámite NIE/TIE/empadronamiento."
              warn
            />
          </section>

          {/* Notas */}
          <section>
            <h2 style={sectionHead}>Notas (opcional)</h2>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              disabled={submitting}
              placeholder="Cualquier cosa que el admin deba saber..."
              style={textareaStyle}
            />
          </section>

          {error ? (
            <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
              {error}
            </p>
          ) : null}

          <Button type="submit" loading={submitting} size="lg">
            Guardar mi perfil
          </Button>
          <p style={{ ...hintStyle, textAlign: 'center', marginTop: 0 }}>
            Puedes volver a esta página y editar tus datos las próximas 72h. Después, el admin
            te genera un link nuevo.
          </p>
        </form>
      </Card>
    </main>
  );
}

function CheckBoxRow({
  checked,
  onChange,
  disabled,
  title,
  description,
  warn,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title: string;
  description: string;
  warn?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: '0.75rem',
        alignItems: 'flex-start',
        padding: '0.7rem 0.875rem',
        borderRadius: 'var(--np-r-md)',
        background: warn && checked ? 'var(--np-warning-bg, #fef3c7)' : 'var(--np-surface-2)',
        border: '1px solid var(--np-border)',
        marginTop: '0.5rem',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        style={{ marginTop: '0.2rem' }}
      />
      <div style={{ flex: 1 }}>
        <p style={{
          margin: 0,
          fontSize: '0.9rem',
          fontWeight: 500,
          color: warn && checked ? '#78350f' : 'var(--np-text)',
        }}>
          {title}
        </p>
        <p style={{
          margin: '0.15rem 0 0',
          fontSize: '0.78rem',
          color: warn && checked ? '#78350f' : 'var(--np-text-mute)',
        }}>
          {description}
        </p>
      </div>
    </label>
  );
}

const pageStyle: CSSProperties = {
  padding: '1.5rem 1rem 3rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
  maxWidth: '36rem',
  margin: '0 auto',
};

const headerStyle: CSSProperties = {
  textAlign: 'center',
};

const cardStyle: CSSProperties = {
  padding: '1.5rem 1.25rem',
};

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

const textareaStyle: CSSProperties = {
  width: '100%',
  background: 'var(--np-bg)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  padding: '0.625rem 0.875rem',
  fontSize: '0.875rem',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
  resize: 'vertical',
  marginTop: '0.5rem',
};
