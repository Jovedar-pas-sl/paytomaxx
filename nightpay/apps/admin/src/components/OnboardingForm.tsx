'use client';

import { useId, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import {
  createSelfOnboardingLink,
  updateOperator,
  type Operator,
  type OnboardingStatus,
  type WalletProvider,
  type WalletStatus,
} from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { changedFields } from '@/lib/diff';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';

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
  NOT_STARTED: 'No empezado',
  REGISTERED: 'Registrado, falta KYC',
  KYC_PENDING: 'KYC enviado, esperando',
  KYC_VERIFIED: 'KYC aprobado, operativa',
  KYC_REJECTED: 'KYC rechazado, probar alternativa',
};

const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
  NEW: 'Nueva (sin tocar)',
  PROFILE_CREATED: 'Alta en OxioPay',
  INVITE_ACTIVATED: 'Cuenta OxioPay activada',
  BINANCE_PENDING: 'Binance/wallet en proceso',
  READY: 'Operativa · puede cobrar y recibir',
  BLOCKED: 'Bloqueada · algún problema sin resolver',
};

/** Lo que guarda este formulario, limpio como se manda al API. */
interface OnboardingValues {
  phone: string | null;
  passportCountry: string | null;
  passportLast4: string | null;
  hasEmpadronamiento: boolean;
  hasNie: boolean;
  hasTie: boolean;
  walletProvider: WalletProvider | null;
  walletStatus: WalletStatus | null;
  walletTestPassed: boolean;
  needsHelpWallet: boolean;
  needsHelpDocs: boolean;
  onboardingStatus: OnboardingStatus;
  onboardingNotes: string | null;
}

function savedValues(operator: Operator): OnboardingValues {
  return {
    phone: operator.phone?.trim() || null,
    passportCountry: operator.passportCountry || null,
    passportLast4: operator.passportLast4?.trim() || null,
    hasEmpadronamiento: operator.hasEmpadronamiento ?? false,
    hasNie: operator.hasNie ?? false,
    hasTie: operator.hasTie ?? false,
    walletProvider: operator.walletProvider ?? null,
    walletStatus: operator.walletStatus ?? null,
    walletTestPassed: operator.walletTestPassed ?? false,
    needsHelpWallet: operator.needsHelpWallet ?? false,
    needsHelpDocs: operator.needsHelpDocs ?? false,
    onboardingStatus: operator.onboardingStatus ?? 'NEW',
    onboardingNotes: operator.onboardingNotes?.trim() || null,
  };
}

/**
 * Banner que el admin usa para generar un link self-onboarding que se le manda
 * a la chica vía WhatsApp. Ella lo abre sin login y rellena su perfil.
 */
function SelfOnboardingLinkBanner({ operatorId }: { operatorId: string }) {
  const tz = useVenueTimezone();
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
      setError('No se pudo copiar: selecciona el enlace y cópialo a mano.');
    }
  }

  return (
    <Card style={selfOnboardingBanner}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 600 }}>
            ¿La chica sabe usar la web?
          </p>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--np-text-mute)' }}>
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
          {link ? 'Regenerar enlace' : 'Generar enlace'}
        </Button>
      </div>

      {link ? (
        <div style={linkBoxStyle}>
          <code style={linkUrlStyle}>{link.url}</code>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <Button type="button" onClick={copy} variant="ghost" size="sm">
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
            {/* Botón secundario como los demás (el verde de WhatsApp con blanco no llegaba a 2:1). */}
            <a
              href={`https://wa.me/?text=${encodeURIComponent(
                `Hola, este es tu link para rellenar tu perfil en OxioPay (válido 72h): ${link.url}`,
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              className="np-btn"
              data-variant="ghost"
              data-size="sm"
            >
              Compartir por WhatsApp
            </a>
          </div>
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
            Caduca: {formatDateTime(link.expiresAt, tz, 'datetime')}
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Seguimiento del alta de una chica. "Guardar" manda solo lo que se cambió en
 * el formulario: antes lo mandaba todo y pisaba lo que la chica había
 * rellenado desde su enlace mientras el formulario estaba abierto.
 */
export function OnboardingForm({ operator, onSaved }: Props) {
  const tz = useVenueTimezone();
  const countryId = useId();
  const providerId = useId();
  const kycId = useId();
  const notesId = useId();
  // Lo que había al abrir y lo último guardado desde aquí: con esto se sabe qué cambió.
  const [opened] = useState(() => savedValues(operator));
  const [baseline, setBaseline] = useState(opened);
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
  const [saved, setSaved] = useState<string | null>(null);

  const current: OnboardingValues = {
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
  };
  // Alguien (la chica desde su enlace, otra persona) guardó cambios desde que se
  // abrió: lo del servidor no es ni lo de al abrir ni lo que se guardó desde aquí
  // (así no salta mientras llega la lista recargada tras guardar).
  const server = savedValues(operator);
  const differsFromOpened = changedFields(opened, server);
  const changedElsewhere = Object.keys(changedFields(baseline, server)).some((k) => k in differsFromOpened);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(null);
    const changes = changedFields(baseline, current);
    if (Object.keys(changes).length === 0) {
      setSaved('No hay cambios que guardar.');
      return;
    }
    setSubmitting(true);
    try {
      await updateOperator(operator.id, changes);
      setBaseline(current);
      setSaved('Guardado');
      setTimeout(() => setSaved(null), 2500);
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

      {changedElsewhere ? (
        <Notice tone="info">
          Hay datos nuevos guardados desde que abriste esto (por ejemplo, desde el enlace de la chica). Al guardar
          solo se manda lo que cambies tú; cierra y vuelve a abrir para verlos.
        </Notice>
      ) : null}

      {/* Estado general */}
      <Card style={summaryCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 500, color: 'var(--np-text-mute)' }}>
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
          <ProgressTile label="Test 1 USDT" value={walletTestPassed ? 'Hecho' : '—'} ok={walletTestPassed} />
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
            <label htmlFor={countryId} style={selectLabel}>
              País del pasaporte
            </label>
            <Select
              id={countryId}
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
            <label htmlFor={providerId} style={selectLabel}>
              Proveedor
            </label>
            <Select
              id={providerId}
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
            <label htmlFor={kycId} style={selectLabel}>
              Estado KYC
            </label>
            <Select
              id={kycId}
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
            Última prueba: {formatDateTime(operator.walletTestAt, tz, 'datetime')}
          </p>
        ) : null}
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--np-text-mute)' }}>
          La dirección concreta de cobro se gestiona en la pestaña <strong>Editar</strong> (campo «Routing del
          payout»). Aquí solo el estado del proceso.
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
        <h4 style={sectionLabel}>
          <label htmlFor={notesId}>Notas / pendientes</label>
        </h4>
        <textarea
          id={notesId}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          maxLength={2000}
          disabled={submitting}
          placeholder='"Esperando cita NIE para 15/06", "Binance rechazó KYC, probando Bybit", "Vuelve a Colombia en julio"...'
          style={textareaStyle}
        />
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
          {notes.length}/2000
        </p>
      </div>

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" style={{ color: 'var(--np-success)', margin: 0, fontSize: '0.875rem' }}>
          {saved}
        </p>
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
        background: warn && checked ? 'var(--np-pill-warning-bg)' : 'var(--np-surface-2)',
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
        <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 500, color: warn && checked ? 'var(--np-warning)' : 'var(--np-text)' }}>
          {title}
        </p>
        <p style={{ margin: '0.15rem 0 0', fontSize: '0.8125rem', color: warn && checked ? 'var(--np-warning)' : 'var(--np-text-mute)' }}>
          {description}
        </p>
      </div>
    </label>
  );
}

function ProgressTile({ label, value, ok, warn }: { label: string; value: string; ok?: boolean; warn?: boolean }) {
  const color = ok ? 'var(--np-success)' : warn ? 'var(--np-warning)' : 'var(--np-text-mute)';
  return (
    <div style={{
      padding: '0.5rem 0.75rem',
      border: '1px solid var(--np-border)',
      borderRadius: 'var(--np-r-md)',
      background: 'var(--np-bg)',
      textAlign: 'center',
    }}>
      <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 500, color: 'var(--np-text-dim)' }}>
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
  fontSize: '0.75rem',
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
  background: 'var(--np-surface-2)',
  borderColor: 'var(--np-border-hi)',
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

