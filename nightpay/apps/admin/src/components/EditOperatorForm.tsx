'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input } from '@nightpay/ui';
import {
  regenerateInvite,
  resetOperatorPassword,
  updateOperator,
  type Operator,
  type PayoutMetadata,
  type PayoutMethod,
} from '@/lib/api';
import { ApiError, needsTotpCode, totpLockedUntil } from '@/lib/api-errors';
import { bpsToPercentInput, parsePercentToBps } from '@/lib/commission';
import { formatDateTime } from '@/lib/dates';
import { changedFields } from '@/lib/diff';
import { OTP_LENGTH } from '@/lib/otp';
import { payoutAddressError, payoutValueFromSaved, touchesPayoutAccount, type PayoutValue } from '@/lib/payout-address';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';
import { PayoutMethodForm } from './PayoutMethodForm';

/** Lo que este formulario puede cambiar de una chica. */
interface EditSnapshot {
  displayName: string;
  commissionBps: number;
  active: boolean;
  payoutMethod: PayoutMethod | null;
  payoutAddress: string | null;
  payoutMetadata: PayoutMetadata | null;
  payoutLabel: string | null;
}

function snapshotOf(operator: Operator): EditSnapshot {
  const payout = payoutValueFromSaved(operator);
  return {
    displayName: (operator.displayName ?? '').trim(),
    commissionBps: operator.commissionBps,
    active: operator.active,
    payoutMethod: payout.method,
    payoutAddress: payout.address,
    payoutMetadata: payout.metadata,
    payoutLabel: payout.label,
  };
}

/**
 * Editar una chica. Solo se manda lo que se cambió: así no se pisa la
 * dirección de cobro que ella guardó desde su enlace mientras tanto. Comisión,
 * estado y método de cobro son del dueño (el API se lo rechaza al encargado).
 * Cambiar la cuenta de cobro, con la 2FA activada, pide el código (el API lo
 * dice con TOTP_REQUIRED y entonces aparece el campo).
 */
export function EditOperatorForm({
  operator,
  isOwner,
  onSaved,
}: {
  operator: Operator;
  isOwner: boolean;
  onSaved: () => void;
}) {
  const [initial] = useState(() => snapshotOf(operator));
  const [displayName, setDisplayName] = useState(operator.displayName ?? '');
  const [commissionPct, setCommissionPct] = useState(bpsToPercentInput(operator.commissionBps));
  const [active, setActive] = useState(operator.active);
  const [payout, setPayout] = useState<PayoutValue>(() => payoutValueFromSaved(operator));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** El API pidió el código 2FA (403 TOTP_REQUIRED) para cambiar la cuenta de cobro. */
  const [askedForCode, setAskedForCode] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  /** 429 TOTP_LOCKED: hasta cuándo no se puede probar otro código. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setNotice(null);
    const commissionBps = parsePercentToBps(commissionPct);
    if (commissionBps === null) {
      return setError('Comisión inválida: un porcentaje de 0 a 100 (por ejemplo 15 o 15,5).');
    }
    const current: EditSnapshot = {
      displayName: displayName.trim(),
      commissionBps,
      active,
      payoutMethod: payout.method,
      payoutAddress: payout.address,
      payoutMetadata: payout.metadata,
      payoutLabel: payout.label,
    };
    const changes = changedFields(initial, current);
    if (changes.displayName !== undefined && !changes.displayName) return setError('Pon un nombre.');
    const addressProblem = payoutAddressError(current.payoutMethod, current.payoutAddress ?? '');
    if (addressProblem && (changes.payoutMethod !== undefined || changes.payoutAddress !== undefined)) {
      return setError(addressProblem);
    }
    // El encargado solo cambia el nombre (lo demás va deshabilitado).
    const allowed: Partial<EditSnapshot> = isOwner
      ? changes
      : changes.displayName !== undefined
        ? { displayName: changes.displayName }
        : {};
    if (Object.keys(allowed).length === 0) return setNotice('No hay cambios que guardar.');
    const withCode = askedForCode && touchesPayoutAccount(allowed);
    if (withCode && totpCode.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');

    setSubmitting(true);
    try {
      await updateOperator(operator.id, withCode ? { ...allowed, totpCode } : allowed);
      onSaved();
    } catch (err) {
      const lockEnds = totpLockedUntil(err, Date.now());
      if (lockEnds !== null) setLockedUntil(lockEnds);
      if (needsTotpCode(err)) setAskedForCode(true);
      if (lockEnds !== null || (err instanceof ApiError && err.code === 'TOTP_INVALID')) setTotpCode('');
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <Input label="Nombre" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
      <Input
        label="Comisión (%)"
        type="text"
        inputMode="decimal"
        value={commissionPct}
        onChange={(e) => setCommissionPct(e.target.value)}
        disabled={!isOwner || submitting}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          disabled={!isOwner || submitting}
        />
        Activa (puede crear cobros)
      </label>
      {isOwner ? null : (
        <p style={hintText}>Solo el dueño cambia la comisión, si está activa y su método de cobro.</p>
      )}

      <div style={sectionBox}>
        <h4 style={sectionHeading}>Acceso y contraseña</h4>
        <AccessPanel operator={operator} isOwner={isOwner} />
      </div>

      <div style={sectionBox}>
        <h4 style={sectionHeading}>Routing del payout (Phase 1A)</h4>
        <PayoutMethodForm
          method={operator.payoutMethod ?? null}
          address={operator.payoutAddress ?? null}
          metadata={operator.payoutMetadata ?? null}
          label={operator.payoutLabel ?? null}
          onChange={setPayout}
          disabled={submitting || !isOwner}
        />
      </div>

      {askedForCode ? (
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={totpCode}
          onChange={setTotpCode}
          autoSubmit
          lockedUntil={lockedUntil}
          disabled={submitting}
          required
          hint="Cambiar a dónde va su dinero pide el código. Al poner el sexto número se guarda."
        />
      ) : null}
      {notice ? <Notice tone="info">{notice}</Notice> : null}
      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
      <Button type="submit" loading={submitting}>
        Guardar
      </Button>
    </form>
  );
}

/**
 * Bloque dentro del modal Editar Operadora para gestionar acceso:
 *   - Si la operadora está pendiente (invitedAt!=null) → "Regenerar enlace"
 *   - Solo el dueño (el API lo exige) → "Resetear contraseña" (pone una o al azar)
 * Las credenciales se muestran UNA vez tras la acción para copiar y mandar
 * por WhatsApp. NightPay no las persiste en claro.
 */
function AccessPanel({ operator, isOwner }: { operator: Operator; isOwner: boolean }) {
  const tz = useVenueTimezone();
  const [busy, setBusy] = useState<'invite' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<{ url: string; expiresAt: string } | null>(null);
  const [resetResult, setResetResult] = useState<{ password: string } | null>(null);
  const [explicitPass, setExplicitPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function handleRegenerateInvite() {
    setBusy('invite');
    setError(null);
    setInviteResult(null);
    setResetResult(null);
    try {
      const r = await regenerateInvite(operator.id);
      setInviteResult({ url: r.inviteUrl, expiresAt: r.expiresAt });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleResetPassword(explicit: boolean) {
    setBusy('reset');
    setError(null);
    setInviteResult(null);
    setResetResult(null);
    try {
      if (explicit && explicitPass.length < 8) {
        throw new Error('La contraseña tiene que tener al menos 8 caracteres.');
      }
      const r = await resetOperatorPassword(operator.id, explicit ? explicitPass : null);
      setResetResult({ password: r.password });
      setExplicitPass('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function copyToClipboard(text: string, kind: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2500);
    } catch {
      setError('No se pudo copiar: selecciónalo y cópialo a mano.');
    }
  }

  const isPending = Boolean(operator.invitedAt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--np-text-mute)' }}>
        Estado:{' '}
        <strong style={{ color: isPending ? 'var(--np-warning)' : 'var(--np-success)' }}>
          {isPending ? 'Pendiente de activar' : 'Cuenta activada'}
        </strong>{' '}
        · Email: <code style={{ fontFamily: 'var(--np-font-mono)', fontSize: '0.8125rem' }}>{operator.email}</code>
      </p>

      {/* Regenerar invitación — solo para pendientes */}
      {isPending ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            onClick={handleRegenerateInvite}
            loading={busy === 'invite'}
            disabled={busy !== null}
          >
            Regenerar enlace de invitación (24 h)
          </Button>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
            Si el enlace original caducó o no llegó por email.
          </p>
        </div>
      ) : null}

      {inviteResult ? (
        <div style={resultBox}>
          <p style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 600 }}>
            Nuevo enlace de invitación, válido hasta {formatDateTime(inviteResult.expiresAt, tz, 'datetime')}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <code style={resultCode}>{inviteResult.url}</code>
            <Button type="button" variant="ghost" onClick={() => copyToClipboard(inviteResult.url, 'invite')}>
              {copied === 'invite' ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
            Mándale este enlace por WhatsApp. Cuando lo abra y ponga su contraseña, el enlace deja de valer.
          </p>
        </div>
      ) : null}

      {/* Resetear contraseña — solo el dueño (el API lo rechaza a los demás) */}
      {isOwner ? (
        <div>
          <p style={{ margin: '0 0 0.3rem', fontSize: '0.8125rem', fontWeight: 500 }}>Resetear contraseña</p>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
            Útil si la chica olvidó su contraseña. La verás UNA vez para copiarla.
          </p>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'stretch', marginBottom: '0.4rem' }}>
            <input
              type={showPass ? 'text' : 'password'}
              value={explicitPass}
              onChange={(e) => setExplicitPass(e.target.value)}
              placeholder="Escribe una (mín. 8) o deja vacío"
              aria-label="Nueva contraseña para la chica"
              autoComplete="new-password"
              name="operator-new-password"
              disabled={busy !== null}
              style={{
                ...passInput,
                fontFamily: showPass ? 'var(--np-font-mono)' : 'inherit',
              }}
            />
            <button
              type="button"
              onClick={() => setShowPass((s) => !s)}
              aria-pressed={showPass}
              aria-label={showPass ? 'Ocultar contraseña' : 'Ver contraseña'}
              style={toggleBtn}
            >
              {showPass ? 'Ocultar' : 'Ver'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleResetPassword(true)}
              disabled={busy !== null || explicitPass.length === 0}
              loading={busy === 'reset' && explicitPass.length > 0}
            >
              Usar esta contraseña
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleResetPassword(false)}
              disabled={busy !== null}
              loading={busy === 'reset' && explicitPass.length === 0}
            >
              Generar una al azar
            </Button>
          </div>
        </div>
      ) : null}

      {resetResult ? (
        <div style={{ ...resultBox, border: '2px solid var(--np-success)' }}>
          <p style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 600 }}>
            Nueva contraseña: apúntala ahora, no se mostrará otra vez
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <code style={passwordCode}>{resetResult.password}</code>
            <Button type="button" variant="ghost" onClick={() => copyToClipboard(resetResult.password, 'pass')}>
              {copied === 'pass' ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
            Email para entrar: <code>{operator.email}</code> · Mándale los dos por WhatsApp.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const hintText: CSSProperties = { margin: 0, fontSize: '0.8125rem', color: 'var(--np-text-mute)' };

const sectionBox: CSSProperties = {
  marginTop: '0.5rem',
  paddingTop: '1rem',
  borderTop: '1px solid var(--np-border)',
};

const sectionHeading: CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '0.75rem',
  color: 'var(--np-text-dim)',
  fontWeight: 500,
};

const resultBox: CSSProperties = {
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border)',
  borderRadius: '0.5rem',
  padding: '0.75rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
};

const resultCode: CSSProperties = {
  flex: 1,
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.75rem',
  padding: '0.5rem',
  background: 'var(--np-surface)',
  borderRadius: '0.3rem',
  wordBreak: 'break-all',
};

const passwordCode: CSSProperties = {
  flex: 1,
  fontFamily: 'var(--np-font-mono)',
  fontSize: '1rem',
  fontWeight: 600,
  padding: '0.6rem',
  background: 'var(--np-surface)',
  borderRadius: '0.3rem',
  textAlign: 'center',
  letterSpacing: '0.05em',
};

const passInput: CSSProperties = {
  flex: 1,
  padding: '0.55rem',
  borderRadius: '0.4rem',
  border: '1px solid var(--np-border)',
  background: 'var(--np-bg-input, var(--np-surface))',
  color: 'var(--np-text)',
  fontSize: '0.875rem',
};

const toggleBtn: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--np-border)',
  borderRadius: '0.4rem',
  padding: '0 0.7rem',
  cursor: 'pointer',
  color: 'var(--np-text-mute)',
  fontFamily: 'inherit',
};
