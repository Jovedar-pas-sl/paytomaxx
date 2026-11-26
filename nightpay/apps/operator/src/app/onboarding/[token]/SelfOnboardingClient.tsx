'use client';

import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Logo, PrivacyNote, Select } from '@nightpay/ui';
import { isMinor, madridToday } from '@nightpay/contracts';
import {
  SelfOnboardingSavedError,
  apiBase,
  fetchSelfOnboardingProfile,
  submitSelfOnboarding,
  type SelfOnboardingProfile,
  type SelfOnboardingSubmitDto,
  type WalletProvider,
  type WalletStatusKYC,
} from '@/lib/api';
import { SkelCard } from '@/components/loading-shapes';
import type { SavedPayout } from '@/lib/payout-address';
import { ONBOARDING_LINK_NOTE, savedScreen, type SavedKind } from './onboarding-copy';
import { EMPTY_PAYOUT, type PayoutValues } from './onboarding-payout';
import {
  identityDto,
  identityProblems,
  pathDto,
  pathPayout,
  pathProblem,
  payoutPaths,
  type PayoutPath,
} from './onboarding-path';
import { PayoutPathSection } from './PayoutPathSection';

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
  NOT_STARTED: 'No he empezado',
  REGISTERED: 'Registrada, falta KYC',
  KYC_PENDING: 'KYC enviado, esperando',
  KYC_VERIFIED: 'KYC aprobado, todo OK',
  KYC_REJECTED: 'KYC rechazado',
};

interface Props {
  token: string;
}

export function SelfOnboardingClient({ token }: Props) {
  const [profile, setProfile] = useState<SelfOnboardingProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Guardado ahora, o ya guardado antes con este enlace (se perdió la respuesta o lo vuelve a abrir). */
  const [done, setDone] = useState<SavedKind | null>(null);

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
  const [payout, setPayout] = useState<PayoutValues>(EMPTY_PAYOUT);
  // Alta con tres caminos: nombre legal, fecha de nacimiento y cómo cobra.
  const [legalName, setLegalName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [path, setPath] = useState<PayoutPath>('NADA');
  /** Guardado con menos de 18 años: su cuenta no se activa (el dueño ya está avisado). */
  const [minorSaved, setMinorSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Tras el primer intento de guardar, los errores se marcan en su campo.
  const [triedSubmit, setTriedSubmit] = useState(false);
  // El servidor guardó todo menos la forma de cobro (no se puede cambiar desde el enlace).
  const [payoutIgnored, setPayoutIgnored] = useState(false);
  // API viejo (sin el campo): se puede, como antes.
  const canSetPayout = profile?.canSetPayout !== false;
  // El enlace nunca devuelve la cuenta entera (y solo deja ponerla a quien no tiene).
  const savedPayout: SavedPayout = { method: profile?.payoutMethod ?? null, address: null };
  // Cada etiqueta, unida a su campo (antes los desplegables no tenían nombre).
  const fieldId = useId();
  const ids = {
    country: `${fieldId}-pais`,
    provider: `${fieldId}-wallet`,
    kyc: `${fieldId}-kyc`,
    notes: `${fieldId}-notas`,
  };

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
      })
      .catch((err) => {
        if (err instanceof SelfOnboardingSavedError) setDone('before');
        else setError((err as Error).message);
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTriedSubmit(true);
    // Nombre legal y fecha (si aún no estaban) y, la cuenta, con la forma de su método.
    const identity = identityProblems({ legalName, birthDate }, profile ?? {});
    const problem = identity.legalName ?? identity.birthDate ?? pathProblem(path, payout, savedPayout);
    if (problem) {
      setError(problem);
      return;
    }
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
        ...identityDto({ legalName, birthDate }),
        // La cuenta (su IBAN u otra forma), la petición de la OxioCard o nada.
        ...pathDto(path, payout),
      };
      const saved = await submitSelfOnboarding(token, dto);
      setPayoutIgnored(Boolean(saved.payoutIgnored));
      setMinorSaved(saved.minor === true);
      setDone('now');
    } catch (err) {
      // La primera vez sí se guardó (se perdió la respuesta): no es un error.
      if (err instanceof SelfOnboardingSavedError) setDone('before');
      else setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="np-screen" style={pageStyle}>
        <SkelCard title fields={3} style={{ ...cardStyle, width: '100%', maxWidth: '28rem' }} />
      </main>
    );
  }
  if (error && !profile) {
    return (
      <main className="np-screen" style={pageStyle}>
        <Card style={{ ...cardStyle, textAlign: 'center', borderColor: 'var(--np-danger)' }}>
          <Logo height="2rem" />
          <h1 style={{ marginTop: '1rem', color: 'var(--np-danger)' }}>Link inválido</h1>
          <p style={{ color: 'var(--np-text-mute)', marginTop: '0.5rem' }}>{error}</p>
          <p style={{ fontSize: 'var(--np-fs-14)', color: 'var(--np-text-dim)', marginTop: '1rem' }}>
            Pídele al admin del local un link nuevo.
          </p>
          {/* Salida: si ya tiene cuenta, a entrar en la app. */}
          <a href="/" className="np-btn" data-variant="ghost" data-size="md" style={{ marginTop: '1rem' }}>
            Entrar
          </a>
        </Card>
      </main>
    );
  }
  if (done) {
    const screen = savedScreen(done);
    return (
      <main className="np-screen" style={pageStyle}>
        <Card style={{ ...cardStyle, textAlign: 'center', borderColor: 'var(--np-success)' }}>
          <Logo height="2rem" />
          <h1 style={{ marginTop: '1rem', color: 'var(--np-success)', fontSize: 'var(--np-fs-22)' }}>{screen.title}</h1>
          <p style={{ color: 'var(--np-text-mute)', marginTop: '0.75rem' }}>{screen.text}</p>
          {minorSaved ? (
            <p role="status" style={{ marginTop: '0.75rem', color: 'var(--np-warning)' }}>
              Con menos de 18 años no se puede activar la cuenta. Hemos avisado al dueño del local.
            </p>
          ) : null}
          {payoutIgnored ? (
            <p role="status" style={{ marginTop: '0.75rem', color: 'var(--np-warning)' }}>
              Tu forma de cobro no se ha cambiado: la configura el admin del local. Si quieres otra, díselo.
            </p>
          ) : null}
          <p style={{ marginTop: '1rem', fontSize: 'var(--np-fs-14)', color: 'var(--np-text-dim)' }}>
            Ya puedes cerrar esta página o entrar en la app.
          </p>
          <a href="/" className="np-btn" data-variant="ghost" data-size="md" style={{ marginTop: '0.75rem' }}>
            Entrar
          </a>
        </Card>
      </main>
    );
  }
  if (!profile) return null;
  const identityErrors = identityProblems({ legalName, birthDate }, profile);

  return (
    <main className="np-screen" style={pageStyle}>
      <header style={headerStyle}>
        <Logo height="2rem" />
        <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' }}>
          {profile.venueName}
        </p>
      </header>

      <Card style={cardStyle}>
        <h1 style={{ margin: 0, fontSize: 'var(--np-fs-22)', fontWeight: 600 }}>
          Tu perfil
        </h1>
        <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' }}>
          Hola{profile.displayName ? `, ${profile.displayName}` : ''}. Esta página es para que
          rellenes tus datos (nombre, fecha de nacimiento, documentos) y digas cómo quieres cobrar.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: '1.5rem' }}>
          {/* Datos personales */}
          <section>
            <h2 style={sectionHead}>Datos personales</h2>
            {/* Ya guardados: desde el enlace no se cambian (los corrige el dueño en el panel). */}
            {profile.legalNameMasked ? (
              <SavedValue
                label="Nombre y apellidos (como en tu documento)"
                value={profile.legalNameMasked}
                hint="Ya lo tenemos. Si hay que corregirlo, díselo al dueño del local."
              />
            ) : (
              <Input
                label="Nombre y apellidos (como en tu documento)"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder="María López Pérez"
                hint="Como en tu pasaporte o tu NIE. Va cifrado."
                error={triedSubmit ? identityErrors.legalName : undefined}
                maxLength={120}
                autoComplete="name"
                disabled={submitting}
              />
            )}
            <div style={{ marginTop: '0.75rem' }}>
              {profile.hasBirthDate ? (
                <SavedValue
                  label="Fecha de nacimiento"
                  value="Ya guardada"
                  hint="Si está mal, díselo al dueño del local."
                />
              ) : (
                <>
                  <Input
                    label="Fecha de nacimiento"
                    type="date"
                    value={birthDate}
                    onChange={(e) => setBirthDate(e.target.value)}
                    min="1900-01-01"
                    max={madridToday()}
                    error={triedSubmit ? identityErrors.birthDate : undefined}
                    autoComplete="bday"
                    disabled={submitting}
                  />
                  {isMinor(birthDate || null, madridToday()) ? (
                    <p role="status" style={{ ...hintStyle, color: 'var(--np-warning)' }}>
                      Con menos de 18 años no se puede activar la cuenta. Si guardas, avisaremos al dueño del local.
                    </p>
                  ) : null}
                </>
              )}
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <Input
                label="Móvil"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+34 6XX XX XX XX"
                disabled={submitting}
                type="tel"
                inputMode="tel"
              />
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <label htmlFor={ids.country} style={selectLabel}>País del pasaporte</label>
              <Select
                id={ids.country}
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
              <label htmlFor={ids.provider} style={selectLabel}>¿Dónde tienes tu wallet?</label>
              <Select
                id={ids.provider}
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
              <label htmlFor={ids.kyc} style={selectLabel}>¿Cómo va el KYC?</label>
              <Select
                id={ids.kyc}
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

          {/* Cómo cobra: su IBAN (solo si el enlace deja poner la cuenta), la OxioCard, abrir una cuenta básica u otra forma. */}
          <PayoutPathSection
            paths={payoutPaths({ canSetPayout, oxiocardEnabled: profile.oxiocardEnabled, oxiocardStatus: profile.oxiocardStatus })}
            path={path}
            onPath={(p) => {
              setPath(p);
              setPayout(pathPayout(p));
            }}
            payout={payout}
            onPayout={setPayout}
            saved={savedPayout}
            showErrors={triedSubmit}
            disabled={submitting}
            legalName={legalName}
            canSetPayout={canSetPayout}
          />

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
            <h2 style={sectionHead}>
              <label htmlFor={ids.notes}>Notas (opcional)</label>
            </h2>
            <textarea
              id={ids.notes}
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
            <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: 'var(--np-fs-14)' }}>
              {error}
            </p>
          ) : null}

          <PrivacyNote apiBase={apiBase} lead="Lo que guardas aquí se trata como explica la" />
          <Button type="submit" loading={submitting} size="lg">
            Guardar mi perfil
          </Button>
          <p style={{ ...hintStyle, textAlign: 'center', marginTop: 0 }}>{ONBOARDING_LINK_NOTE}</p>
        </form>
      </Card>
    </main>
  );
}

/** Un dato ya guardado: se ve, pero no se cambia desde el enlace. */
function SavedValue({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p style={{ ...selectLabel, marginTop: 0 }}>{label}</p>
      <p style={{ margin: 0 }}>{value}</p>
      <p style={hintStyle}>{hint}</p>
    </div>
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
          fontSize: 'var(--np-fs-14)',
          fontWeight: 500,
          color: warn && checked ? '#78350f' : 'var(--np-text)',
        }}>
          {title}
        </p>
        <p style={{
          margin: '0.15rem 0 0',
          fontSize: 'var(--np-fs-14)',
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

const textareaStyle: CSSProperties = {
  width: '100%',
  background: 'var(--np-bg)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  padding: '0.625rem 0.875rem',
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
  resize: 'vertical',
  marginTop: '0.5rem',
};
