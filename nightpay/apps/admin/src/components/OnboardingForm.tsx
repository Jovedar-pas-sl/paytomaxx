'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import {
  createSelfOnboardingLink,
  updateOperator,
  type Operator,
  type OnboardingStatus,
  type WalletProvider,
  type WalletStatus,
} from '@/lib/api';

interface Props {
  operator: Operator;
  onSaved: () => void;
}

const LATAM_COUNTRIES = [
  'Argentina', 'Bolivia', 'Brasil', 'Chile', 'Colombia',
  'Cuba', 'Ecuador', 'El Salvador', 'Guatemala', 'Honduras',
  'México', 'Nicaragua', 'Panamá', 'Paraguay', 'Perú',
  'Puerto Rico', 'República Dominicana', 'Uruguay', 'Venezuela',
];

const WALLET_PROVIDER_LABELS: Record<WalletProvider, string> = {
  BINANCE: 'Binance (recomendado · pasaporte LatAm)',
  BYBIT: 'Bybit (alternativa Binance)',
  OKX: 'OKX (alternativa Binance)',
  CRYPTO_COM: 'Crypto.com Card',
  TRUST_WALLET: 'Trust Wallet (self-custody, sin KYC)',
  FASTERPAY: 'FasterPay (e-wallet, no cripto)',
  PAYQUICKER: 'PayQuicker (e-wallet, no cripto)',
  WISE: 'Wise (transferencias EU)',
  REVOLUT: 'Revolut (IBAN EU)',
  OTHER: 'Otro (notas abajo)',
  NONE: 'Ninguno todavía',
};

const WALLET_STATUS_LABELS: Record<WalletStatus, string> = {
  NOT_STARTED: '🔴 No empezado',
  REGISTERED: '🟡 Registrado, falta KYC',
  KYC_PENDING: '🟠 KYC enviado, esperando',
  KYC_VERIFIED: '🟢 KYC aprobado, operativa',
  KYC_REJECTED: '⛔ KYC rechazado, probar alternativa',
};

const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
  NEW: '⚪ Nueva (sin tocar)',
  PROFILE_CREATED: '🟡 Alta en OxioPay',
  INVITE_ACTIVATED: '🟠 Cuenta OxioPay activada',
  BINANCE_PENDING: '🔵 Binance/wallet en proceso',
  READY: '🟢 Operativa · puede cobrar y recibir',
  BLOCKED: '🔴 Bloqueada · algún problema sin resolver',
};

/**
 * Banner que el admin usa para generar un link self-onboarding que se le manda
 * a la chica vía WhatsApp. Ella lo abre sin login y rellena su perfil.
 */
function SelfOnboardingLinkBanner({ operatorId }: { operatorId: string }) {
  const [generating, setGenerating] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const result = await createSelfOnboardingLink(operatorId);
      setLink(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <Card style={selfOnboardingBanner}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600 }}>
            ¿La chica sabe usar la web?
          </p>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
            Mándale un link de 72h y ella misma rellena sus datos (pasaporte, KYC,
            wallet). Si no sabe, rellénalos tú abajo y ya.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={generate}
          loading={generating}
        >
          {link ? '↻ Regenerar' : '📤 Generar link'}
        </Button>
      </div>

      {link ? (
        <div style={linkBoxStyle}>
          <code style={linkUrlStyle}>{link.url}</code>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <Button type="button" onClick={copy} variant="ghost">
              {copied ? '✓ Copiado' : 'Copiar'}
            </Button>
            <a
              href={`https://wa.me/?text=${encodeURIComponent(
                `Hola, este es tu link para rellenar tu perfil en OxioPay (válido 72h): ${link.url}`,
              )}`}
              target="_blank"
              rel="noreferrer"
              style={whatsappBtnStyle}
            >
              💬 Compartir WhatsApp
            </a>
          </div>
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.72rem', color: 'var(--np-text-dim)' }}>
            Caduca: {new Date(link.expiresAt).toLocaleString('es-ES')}
          </p>
        </div>
      ) : null}

      {error ? (
        <p style={{ color: 'var(--np-danger)', margin: '0.5rem 0 0', fontSize: '0.85rem' }}>{error}</p>
      ) : null}
    </Card>
  );
}

export function OnboardingForm({ operator, onSaved }: Props) {
  const [phone, setPhone] = useState(operator.phone ?? '');
  const [passportCountry, setPassportCountry] = useState(operator.passportCountry ?? '');
  const [passportLast4, setPassportLast4] = useState(operator.passportLast4 ?? '');
  const [hasEmpadronamiento, setHasEmpadronamiento] = useState(operator.hasEmpadronamiento ?? false);
  const [hasNie, setHasNie] = useState(operator.hasNie ?? false);
  const [hasTie, setHasTie] = useState(operator.hasTie ?? false);
  const [walletProvider, setWalletProvider] = useState<WalletProvider | ''>(operator.walletProvider ?? '');
  const [walletStatus, setWalletStatus] = useState<WalletStatus | ''>(operator.walletStatus ?? '');
  const [walletTestPassed, setWalletTestPassed] = useState(operator.walletTestPassed ?? false);
  const [needsHelpWallet, setNeedsHelpWallet] = useState(operator.needsHelpWallet ?? false);
  const [needsHelpDocs, setNeedsHelpDocs] = useState(operator.needsHelpDocs ?? false);
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus>(operator.onboardingStatus ?? 'NEW');
  const [notes, setNotes] = useState(operator.onboardingNotes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      await updateOperator(operator.id, {
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
        onboardingStatus,
        onboardingNotes: notes.trim() || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // Calculados visuales
  const docScore = [hasEmpadronamiento, hasNie, hasTie].filter(Boolean).length;
  const walletReady = walletStatus === 'KYC_VERIFIED' && walletTestPassed;

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Self-onboarding link generator */}
      <SelfOnboardingLinkBanner operatorId={operator.id} />

      {/* Estado general */}
      <Card style={summaryCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--np-text-mute)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Estado del onboarding
          </p>
          <Select
            value={onboardingStatus}
            onChange={(e) => setOnboardingStatus(e.target.value as OnboardingStatus)}
            disabled={submitting}
            style={{ minWidth: '18rem' }}
          >
            {(Object.keys(ONBOARDING_STATUS_LABELS) as OnboardingStatus[]).map((s) => (
              <option key={s} value={s}>{ONBOARDING_STATUS_LABELS[s]}</option>
            ))}
          </Select>
        </div>
        <div style={progressGrid}>
          <ProgressTile label="Documentos" value={`${docScore}/3`} ok={docScore >= 2} />
          <ProgressTile label="Wallet" value={walletReady ? 'OK' : walletStatus ? '…' : '—'} ok={walletReady} />
          <ProgressTile label="Test 1 USDT" value={walletTestPassed ? '✓' : '—'} ok={walletTestPassed} />
          <ProgressTile label="Pide ayuda" value={needsHelpWallet || needsHelpDocs ? 'SÍ' : '—'} warn={needsHelpWallet || needsHelpDocs} />
        </div>
      </Card>

      {/* Datos personales */}
      <div>
        <h4 style={sectionLabel}>Datos personales</h4>
        <div style={twoCol}>
          <Input
            label="Móvil"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+34 6XX XX XX XX"
            disabled={submitting}
          />
          <div>
            <label style={selectLabel}>País del pasaporte</label>
            <Select
              value={passportCountry}
              onChange={(e) => setPassportCountry(e.target.value)}
              disabled={submitting}
            >
              <option value="">— Sin asignar —</option>
              {LATAM_COUNTRIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
              <option value="Otro">Otro</option>
            </Select>
          </div>
        </div>
        <Input
          label="Últimos 4 dígitos del pasaporte"
          value={passportLast4}
          onChange={(e) => setPassportLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="8742"
          maxLength={4}
          hint="Solo últimos 4 — no guardes el número completo por privacidad."
          disabled={submitting}
        />
      </div>

      {/* Documentación residencia España */}
      <div>
        <h4 style={sectionLabel}>Documentación residencia España</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <CheckBoxRow
            checked={hasEmpadronamiento}
            onChange={setHasEmpadronamiento}
            disabled={submitting}
            title="Empadronamiento"
            description="Registro municipal. Sirve como comprobante domicilio para Wise/Revolut."
          />
          <CheckBoxRow
            checked={hasNie}
            onChange={setHasNie}
            disabled={submitting}
            title="NIE (Número Identidad Extranjero)"
            description="Permite abrir Revolut/Wise/Bnext en algunos casos."
          />
          <CheckBoxRow
            checked={hasTie}
            onChange={setHasTie}
            disabled={submitting}
            title="TIE (residencia legal)"
            description="Permiso de residencia con tarjeta. Abre todos los bancos españoles."
          />
        </div>
      </div>

      {/* Wallet / Binance */}
      <div>
        <h4 style={sectionLabel}>Wallet / Exchange de payout</h4>
        <div style={twoCol}>
          <div>
            <label style={selectLabel}>Proveedor</label>
            <Select
              value={walletProvider}
              onChange={(e) => setWalletProvider(e.target.value as WalletProvider | '')}
              disabled={submitting}
            >
              <option value="">— Sin asignar —</option>
              {(Object.keys(WALLET_PROVIDER_LABELS) as WalletProvider[]).map((p) => (
                <option key={p} value={p}>{WALLET_PROVIDER_LABELS[p]}</option>
              ))}
            </Select>
          </div>
          <div>
            <label style={selectLabel}>Estado KYC</label>
            <Select
              value={walletStatus}
              onChange={(e) => setWalletStatus(e.target.value as WalletStatus | '')}
              disabled={submitting}
            >
              <option value="">— Sin asignar —</option>
              {(Object.keys(WALLET_STATUS_LABELS) as WalletStatus[]).map((s) => (
                <option key={s} value={s}>{WALLET_STATUS_LABELS[s]}</option>
              ))}
            </Select>
          </div>
        </div>
        <CheckBoxRow
          checked={walletTestPassed}
          onChange={setWalletTestPassed}
          disabled={submitting}
          title="Prueba 1 USDT confirmada"
          description="Marca cuando hayas hecho el envío de prueba y la chica confirme que recibió. Se guarda fecha + hora."
        />
        {operator.walletTestAt ? (
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
            Última prueba: {new Date(operator.walletTestAt).toLocaleString('es-ES')}
          </p>
        ) : null}
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
          ℹ️ La address concreta de payout se gestiona en la tab <strong>Edit</strong> (campo "Routing del payout"). Aquí solo el estado del proceso.
        </p>
      </div>

      {/* Ayuda necesaria */}
      <div>
        <h4 style={sectionLabel}>¿Necesita ayuda?</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <CheckBoxRow
            checked={needsHelpWallet}
            onChange={setNeedsHelpWallet}
            disabled={submitting}
            title="Necesita ayuda con la wallet"
            description="No sabe abrir Binance / no entiende cripto / KYC le sale rechazado."
            warn
          />
          <CheckBoxRow
            checked={needsHelpDocs}
            onChange={setNeedsHelpDocs}
            disabled={submitting}
            title="Necesita ayuda con documentación"
            description="Falta empadronamiento, NIE en proceso, o cualquier trámite legal."
            warn
          />
        </div>
      </div>

      {/* Notas libres */}
      <div>
        <h4 style={sectionLabel}>Notas / pendientes</h4>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          maxLength={2000}
          disabled={submitting}
          placeholder='"Esperando cita NIE para 15/06", "Binance rechazó KYC, probando Bybit", "Vuelve a Colombia en julio"...'
          style={textareaStyle}
        />
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: 'var(--np-text-dim)' }}>
          {notes.length}/2000
        </p>
      </div>

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
      {saved ? (
        <p style={{ color: 'var(--np-success)', margin: 0, fontSize: '0.875rem' }}>✓ Guardado</p>
      ) : null}
      <Button type="submit" loading={submitting}>
        Guardar onboarding
      </Button>
    </form>
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
        padding: '0.625rem 0.875rem',
        borderRadius: 'var(--np-r-md)',
        background: warn && checked ? 'var(--np-warning-bg, #fef3c7)' : 'var(--np-surface-2)',
        border: '1px solid var(--np-border)',
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
        <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 500, color: warn && checked ? '#78350f' : 'var(--np-text)' }}>
          {title}
        </p>
        <p style={{ margin: '0.15rem 0 0', fontSize: '0.78rem', color: warn && checked ? '#78350f' : 'var(--np-text-mute)' }}>
          {description}
        </p>
      </div>
    </label>
  );
}

function ProgressTile({ label, value, ok, warn }: { label: string; value: string; ok?: boolean; warn?: boolean }) {
  const color = ok ? 'var(--np-success)' : warn ? 'var(--np-warning, #f59e0b)' : 'var(--np-text-mute)';
  return (
    <div style={{
      padding: '0.5rem 0.75rem',
      border: '1px solid var(--np-border)',
      borderRadius: 'var(--np-r-md)',
      background: 'var(--np-bg)',
      textAlign: 'center',
    }}>
      <p style={{ margin: 0, fontSize: '0.65rem', color: 'var(--np-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </p>
      <p className="np-num" style={{ margin: '0.2rem 0 0', fontSize: '1rem', fontWeight: 600, color }}>
        {value}
      </p>
    </div>
  );
}

const summaryCard: CSSProperties = {
  padding: '1rem',
  background: 'var(--np-surface-2)',
};

const progressGrid: CSSProperties = {
  marginTop: '0.75rem',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(6rem, 1fr))',
  gap: '0.5rem',
};

const sectionLabel: CSSProperties = {
  margin: '0 0 0.625rem',
  fontSize: '0.7rem',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--np-text-dim)',
  fontWeight: 500,
};

const selectLabel: CSSProperties = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
  marginBottom: '0.375rem',
};

const twoCol: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
  gap: '0.75rem',
  marginBottom: '0.75rem',
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
};

const selfOnboardingBanner: CSSProperties = {
  padding: '1rem',
  background: 'linear-gradient(135deg, var(--np-surface-2), var(--np-bg))',
  borderColor: 'var(--np-accent)',
};

const linkBoxStyle: CSSProperties = {
  marginTop: '0.75rem',
  padding: '0.75rem',
  background: 'var(--np-bg)',
  border: '1px dashed var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};

const linkUrlStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  fontFamily: 'var(--np-font-mono, monospace)',
  color: 'var(--np-text-mute)',
  wordBreak: 'break-all',
  lineHeight: 1.4,
};

const whatsappBtnStyle: CSSProperties = {
  padding: '0.5rem 0.875rem',
  background: '#25D366',
  color: 'white',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.85rem',
  fontWeight: 500,
  textDecoration: 'none',
  border: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
};
