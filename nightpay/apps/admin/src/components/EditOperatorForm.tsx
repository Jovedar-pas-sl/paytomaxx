'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Checkbox, FormError, Input } from '@nightpay/ui';
import {
  regenerateInvite,
  resetOperatorPassword,
  updateOperator,
  type Operator,
} from '@/lib/api';
import { ApiError, totpLockedUntil } from '@/lib/api-errors';
import { bpsToPercentInput, parsePercentToBps } from '@/lib/commission';
import { formatDateTime } from '@/lib/dates';
import { changedFields } from '@/lib/diff';
import { OTP_LENGTH } from '@/lib/otp';
import { holderNotice, minorNow, payoutHoldText, twoFactorNeededText } from '@/lib/payout-account-view';
import { payoutValueProblem, type PayoutValue } from '@/lib/payout-address';
import { useTwoFactorEnabled } from '@/lib/use-two-factor';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';
import { PAYOUT_METHOD_LABELS, PayoutMethodForm } from './PayoutMethodForm';

/** Lo que este formulario puede cambiar de una chica (la cuenta de cobro va aparte). */
interface EditSnapshot {
  displayName: string;
  commissionBps: number;
  active: boolean;
}

function snapshotOf(operator: Operator): EditSnapshot {
  return {
    displayName: (operator.displayName ?? '').trim(),
    commissionBps: operator.commissionBps,
    active: operator.active,
  };
}

/**
 * Editar una chica. Solo se manda lo que se cambió. Comisión, estado y cuenta
 * de cobro son del dueño (el API se lo rechaza al encargado). La cuenta llega
 * tapada: «Cambiar la cuenta de cobro» pide la nueva entera y siempre el
 * código 2FA del dueño (sin 2FA activada no se puede: se le dice dónde activarla).
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
  /** «Cambiar la cuenta de cobro»: la nueva entera (la de ahora va tapada). */
  const [changingPayout, setChangingPayout] = useState(false);
  const [payout, setPayout] = useState<PayoutValue | null>(null);
  /** «La cuenta es suya»: el titular no coincide con su nombre legal y el dueño lo confirma (con su 2FA). */
  const [confirmingHolder, setConfirmingHolder] = useState(false);
  const withCode = changingPayout || confirmingHolder;
  // Sin la 2FA activada no se cambia: se dice antes de que escriba nada.
  const without2fa = useTwoFactorEnabled(isOwner && withCode) === false;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    const current: EditSnapshot = { displayName: displayName.trim(), commissionBps, active };
    const changes = changedFields(initial, current);
    if (changes.displayName !== undefined && !changes.displayName) return setError('Pon un nombre.');
    // La cuenta nueva, entera (método, cuenta, titular en SEPA y SWIFT, alias).
    const withPayout = isOwner && changingPayout && !without2fa;
    if (withPayout) {
      if (!payout) return setError('Elige el método y escribe la cuenta nueva.');
      const problem = payoutValueProblem(payout);
      if (problem) return setError(problem);
    }
    const payoutChanges = {
      ...(withPayout && payout
        ? { payoutMethod: payout.method, payoutAddress: payout.address, payoutMetadata: payout.metadata, payoutLabel: payout.label }
        : {}),
      ...(isOwner && confirmingHolder && !without2fa ? { payoutHolderConfirmed: true as const } : {}),
    };
    const needsCode = Object.keys(payoutChanges).length > 0;
    // El encargado solo cambia el nombre (lo demás va deshabilitado).
    const allowed = isOwner
      ? { ...changes, ...payoutChanges }
      : changes.displayName !== undefined
        ? { displayName: changes.displayName }
        : {};
    if (Object.keys(allowed).length === 0) return setNotice('No hay cambios que guardar.');
    if (needsCode && totpCode.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');

    setSubmitting(true);
    try {
      await updateOperator(operator.id, needsCode ? { ...allowed, totpCode } : allowed);
      onSaved();
    } catch (err) {
      const lockEnds = totpLockedUntil(err, Date.now());
      if (lockEnds !== null) setLockedUntil(lockEnds);
      if (lockEnds !== null || (err instanceof ApiError && err.code === 'TOTP_INVALID')) setTotpCode('');
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function stopChangingPayout() {
    setChangingPayout(false);
    setConfirmingHolder(false);
    setPayout(null);
    setTotpCode('');
    setError(null);
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
      <Checkbox label="Activa (puede crear cobros)" checked={active} onChange={setActive} disabled={!isOwner || submitting} />
      {isOwner ? null : (
        <p style={hintText}>Solo el dueño cambia la comisión, si está activa y su método de cobro.</p>
      )}

      <div style={sectionBox}>
        <h4 style={sectionHeading}>Acceso y contraseña</h4>
        <AccessPanel operator={operator} isOwner={isOwner} />
      </div>

      <div style={sectionBox}>
        <h4 style={sectionHeading}>Cuenta de cobro</h4>
        <PayoutAccountSummary operator={operator} />
        {isOwner && operator.payoutHolderUnconfirmed && !changingPayout ? (
          confirmingHolder ? (
            without2fa ? (
              <Notice tone="warning">{twoFactorNeededText('change')}</Notice>
            ) : (
              <p style={{ ...hintText, marginTop: '0.5rem' }}>
                Confirmas que la cuenta es de ella aunque el titular no coincida con su nombre legal. Pon tu código abajo.
              </p>
            )
          ) : (
            <Button type="button" variant="ghost" style={{ marginTop: '0.75rem' }} onClick={() => setConfirmingHolder(true)}>
              La cuenta es suya: confirmar
            </Button>
          )
        ) : null}
        {!isOwner ? (
          <p style={{ ...hintText, marginTop: '0.5rem' }}>Solo el dueño cambia la cuenta de cobro.</p>
        ) : changingPayout && without2fa ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
            <Notice tone="warning">{twoFactorNeededText('change')}</Notice>
            <Button type="button" variant="ghost" onClick={stopChangingPayout} disabled={submitting}>
              No cambiar la cuenta
            </Button>
          </div>
        ) : changingPayout ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
            <PayoutMethodForm
              method={operator.payoutMethod ?? null}
              address={null}
              metadata={operator.payoutMetadata ?? null}
              label={operator.payoutLabel ?? null}
              onChange={setPayout}
              disabled={submitting}
              // Con nombre legal (aquí llega tapado) lo compara el API al guardar; sin él, con su nombre del panel.
              personName={operator.legalNameMasked ? null : operator.displayName}
            />
            {operator.payoutAddressMasked ? (
              <p style={hintText}>La cuenta de ahora está tapada ({operator.payoutAddressMasked}): escribe la nueva entera.</p>
            ) : null}
            <Button type="button" variant="ghost" onClick={stopChangingPayout} disabled={submitting}>
              No cambiar la cuenta
            </Button>
          </div>
        ) : (
          <Button type="button" variant="ghost" style={{ marginTop: '0.75rem' }} onClick={() => setChangingPayout(true)}>
            Cambiar la cuenta de cobro
          </Button>
        )}
      </div>

      {isOwner && withCode && !without2fa ? (
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={totpCode}
          onChange={setTotpCode}
          autoSubmit
          lockedUntil={lockedUntil}
          disabled={submitting}
          required
          hint={
            changingPayout
              ? 'Cambiar a dónde va su dinero pide siempre tu código. Le avisamos en su app (y por email, si el correo está activado). Si ya tenía una cuenta, a la nueva no se le paga hasta pasadas 48 h (en efectivo, sí). Al poner el sexto número se guarda.'
              : 'Confirmar que la cuenta es suya pide tu código. Al poner el sexto número se guarda.'
          }
        />
      ) : null}
      {notice ? <Notice tone="info">{notice}</Notice> : null}
      {error ? (
        <FormError>
          {error}
        </FormError>
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
  const minor = minorNow(operator.birthDate);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
        Estado:{' '}
        <strong style={{ color: isPending ? 'var(--np-warning)' : 'var(--np-success)' }}>
          {isPending ? 'Pendiente de activar' : 'Cuenta activada'}
        </strong>{' '}
        · Email: <code style={{ fontFamily: 'var(--np-font-mono)', fontSize: '0.875rem' }}>{operator.email}</code>
      </p>
      {minor ? (
        <Notice tone="danger">Según su fecha de nacimiento tiene menos de 18 años: su cuenta no se puede activar.</Notice>
      ) : null}

      {/* Regenerar invitación — solo para pendientes (y mayores de edad) */}
      {isPending && !minor ? (
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
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: 'var(--np-text-dim)' }}>
            Si el enlace original caducó o no llegó por email.
          </p>
        </div>
      ) : null}

      {inviteResult ? (
        <div style={resultBox}>
          <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 600 }}>
            Nuevo enlace de invitación, válido hasta {formatDateTime(inviteResult.expiresAt, tz, 'datetime')}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <code style={resultCode}>{inviteResult.url}</code>
            <Button type="button" variant="ghost" onClick={() => copyToClipboard(inviteResult.url, 'invite')}>
              {copied === 'invite' ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--np-text-dim)' }}>
            Mándale este enlace por WhatsApp. Cuando lo abra y ponga su contraseña, el enlace deja de valer.
          </p>
        </div>
      ) : null}

      {/* Resetear contraseña — solo el dueño (el API lo rechaza a los demás) y no a una menor */}
      {isOwner && !minor ? (
        <div>
          <p style={{ margin: '0 0 0.3rem', fontSize: '0.875rem', fontWeight: 400 }}>Resetear contraseña</p>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: 'var(--np-text-dim)' }}>
            Útil si la compañera olvidó su contraseña. La verás UNA vez para copiarla.
          </p>
          {/* «Ver» / «Ocultar», el del campo común (Input). */}
          <div style={{ marginBottom: '0.4rem' }}>
            <Input
              type="password"
              value={explicitPass}
              onChange={(e) => setExplicitPass(e.target.value)}
              placeholder="Escribe una (mín. 8) o deja vacío"
              aria-label="Nueva contraseña para la compañera"
              autoComplete="new-password"
              name="operator-new-password"
              disabled={busy !== null}
            />
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
          <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 600 }}>
            Nueva contraseña: apúntala ahora, no se mostrará otra vez
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <code style={passwordCode}>{resetResult.password}</code>
            <Button type="button" variant="ghost" onClick={() => copyToClipboard(resetResult.password, 'pass')}>
              {copied === 'pass' ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--np-text-dim)' }}>
            Email para entrar: <code>{operator.email}</code> · Mándale los dos por WhatsApp.
          </p>
        </div>
      ) : null}

      {error ? (
        <FormError>
          {error}
        </FormError>
      ) : null}
    </div>
  );
}

/** La cuenta de cobro de ahora, tapada, con sus avisos (titular y 48 h). */
function PayoutAccountSummary({ operator }: { operator: Operator }) {
  const tz = useVenueTimezone();
  const method = operator.payoutMethod ?? null;
  if (!method) return <p style={hintText}>Sin cuenta de cobro todavía.</p>;
  const hold = payoutHoldText(operator.payoutHoldUntil, method, Date.now(), tz);
  const holder = holderNotice(operator);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.875rem' }}>
      <strong>{PAYOUT_METHOD_LABELS[method]}</strong>
      {operator.payoutAddressMasked ? <span style={monoText}>{operator.payoutAddressMasked}</span> : null}
      {operator.payoutHolderMasked ? <span style={hintText}>Titular: {operator.payoutHolderMasked}</span> : null}
      {operator.payoutLabel ? <span style={hintText}>Alias: {operator.payoutLabel}</span> : null}
      {holder ? <Notice tone={holder.tone}>{holder.text}</Notice> : null}
      {hold ? <Notice tone="info">{hold}</Notice> : null}
    </div>
  );
}

const hintText: CSSProperties = { margin: 0, fontSize: '0.875rem', color: 'var(--np-text-mute)' };

const monoText: CSSProperties = { fontFamily: 'var(--np-font-mono)', fontSize: '0.875rem', wordBreak: 'break-all' };

const sectionBox: CSSProperties = {
  marginTop: '0.5rem',
  paddingTop: '1rem',
  borderTop: '1px solid var(--np-border)',
};

const sectionHeading: CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '0.875rem',
  color: 'var(--np-text-dim)',
  fontWeight: 400,
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
  fontSize: '0.875rem',
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
