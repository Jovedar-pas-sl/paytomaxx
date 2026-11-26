'use client';

import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Modal } from '@nightpay/ui';
import {
  approveQrCharge,
  fetchPayoutPreview,
  fetchPendingQrCharges,
  lookupWalletCode,
  payoutWallet,
  relinkWallet,
  resetWalletPin,
  unlockWalletPin,
  type PendingQrCharge,
  type WalletPayoutMethod,
  type WalletPayoutPreview,
} from '@/lib/api';
import { totpLockedUntil, totpRetryState } from '@/lib/api-errors';
import { walletPayoutSummary } from '@/lib/confirm-summary';
import { balanceAfterPayout, canFinishPayout, isPayoutAmountChanged, KEEP_RULE, payoutDoneText, payoutPlan } from '@/lib/wallet-payout';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { useLockActive } from '@/lib/use-lock';
import { useVenue, useVenueTimezone } from '@/lib/venue-context';
import { ConfirmLine } from './ConfirmLine';
import { OtpInput } from './OtpInput';

/** Un saldo de la lista o encontrado por el código del cliente. */
export interface PayoutTarget {
  walletId: string;
  code: string | null;
  balanceCents: number;
  label: string | null;
  /** Cargado en este local: solo desde aquí se apunta la devolución a la tarjeta. */
  isHomeVenue: boolean;
  /**
   * Una devolución pedida antes de la nueva regla («Me voy» o recepción), sin
   * terminar. Sin eso solo se termina una a la tarjeta a medias (el dueño).
   */
  closeRequested: boolean;
}

/** El cliente de otro local del grupo: se le encuentra por su código. */
export function CodeSearch({ onFound }: { onFound: (target: PayoutTarget) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const found = await lookupWalletCode(code);
      onFound({
        walletId: found.walletId,
        code: found.code,
        balanceCents: found.balanceCents,
        label: found.label,
        isHomeVenue: found.isHomeVenue,
        closeRequested: found.closeRequested,
      });
      setCode('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: '1rem' }}>
      <h3 style={sectionTitle}>Buscar un saldo por su código</h3>
      <p style={{ margin: '0.25rem 0 0.75rem', fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
        Pon el código que sale en su página de saldo (vale aunque cargara en otro local). Aquí se terminan las
        devoluciones pedidas antes de la nueva regla.
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        <Input
          aria-label="Código del cliente"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
          // Un ejemplo que no parezca un valor ya escrito (np-code-input: el ejemplo, sin el espaciado del código).
          placeholder="p. ej. K7Q4M2"
          className="np-code-input"
          autoComplete="off"
          spellCheck={false}
          style={{ letterSpacing: '0.2em', fontWeight: 700 }}
        />
        <Button type="submit" loading={busy} disabled={code.length !== 6}>
          Buscar
        </Button>
      </form>
      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Lo que el API devolvería ahora por cada camino (no el saldo entero). Se
 * pide al abrir y otra vez si al confirmar el saldo ya se había movido.
 */
function usePayoutPreview(walletId: string) {
  const [preview, setPreview] = useState<WalletPayoutPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchPayoutPreview(walletId)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [walletId, attempt]);

  function reload(): void {
    setPreview(null);
    setAttempt((n) => n + 1);
  }

  return { preview, previewError: error, reloadPreview: reload };
}

export function PayoutModal({
  target,
  isOwner,
  onRelink,
  onClose,
}: {
  target: PayoutTarget;
  isOwner: boolean;
  /** Solo el dueño: el cliente perdió el enlace de su saldo. */
  onRelink?: () => void;
  onClose: () => void;
}) {
  const noteId = useId();
  const [method, setMethod] = useState<WalletPayoutMethod>('CASH');
  const canCard = isOwner && target.isHomeVenue;
  // Sin la petición de antes del cliente (solo una a la tarjeta a medias), la termina el dueño.
  const canPay = isOwner || target.closeRequested;
  const [bankReference, setBankReference] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** Lo que queda tras devolver: la cabecera lo dice (antes seguía con el saldo de antes). */
  const [afterCents, setAfterCents] = useState<number | null>(null);
  /** El encargado en efectivo desde el umbral del local: el API pide su código 2FA. */
  const [askedForCode, setAskedForCode] = useState(false);
  const [totp, setTotp] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);
  const venue = useVenue();
  const { preview, previewError, reloadPreview } = usePayoutPreview(target.walletId);
  // Lo que hará el API por este camino: el botón, la confirmación y el texto dicen esa cifra.
  const plan = preview ? payoutPlan(preview, method) : null;
  const amountCents = plan?.amountCents ?? 0;
  // El dueño, siempre (devuelve sin que el cliente lo pida); el encargado, desde el umbral en efectivo.
  const withCode = isOwner || (askedForCode && method === 'CASH');
  const balanceCents = afterCents ?? preview?.balanceCents ?? target.balanceCents;
  // El saldo no se devuelve: aquí solo se termina una devolución pedida antes de la nueva regla.
  const finishable = canFinishPayout(target, preview);
  const checking = !finishable && preview === null && previewError === null;

  async function handleSubmit() {
    if (submitting || !plan || amountCents <= 0) return;
    if (withCode && !/^\d{6}$/.test(totp)) return setError('Pon los 6 números de tu app de verificación.');
    setSubmitting(true);
    setError(null);
    try {
      const res = await payoutWallet(target.walletId, {
        method,
        bankReference: method === 'CARD' ? bankReference.trim() || undefined : undefined,
        note: note.trim() || undefined,
        totpCode: withCode ? totp : undefined,
        // Si el API ya apuntaría otra cifra (el saldo se movió), 409 y no se toca nada.
        expectedAmountCents: amountCents,
      });
      setDone(payoutDoneText(res, plan));
      setAfterCents(balanceAfterPayout(res, plan, balanceCents));
    } catch (err) {
      const retry = totpRetryState(err, Date.now());
      if (retry.lockedUntil !== null) setLockedUntil(retry.lockedUntil);
      if (retry.askCode) setAskedForCode(true);
      setTotp('');
      setError((err as Error).message);
      if (isPayoutAmountChanged(err)) reloadPreview();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title={finishable ? 'Terminar devolución' : 'Saldo del cliente'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={summaryStyle}>
          <p style={{ margin: 0, fontSize: '0.875rem' }}>
            Saldo: <strong className="np-num">{formatEur(balanceCents)}</strong>
          </p>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
            {[target.code, target.label].filter(Boolean).join(' · ')}
          </p>
        </div>

        {onRelink && !done ? (
          <button type="button" onClick={onRelink} style={linkStyle}>
            ¿El cliente perdió el enlace de su saldo? Darle uno nuevo
          </button>
        ) : null}

        {done ? (
          <>
            <p role="status" style={{ margin: 0, color: 'var(--np-success)', fontWeight: 600 }}>
              {done}
            </p>
            <Button onClick={onClose}>Cerrar</Button>
          </>
        ) : !finishable ? (
          <>
            <p style={helpStyle}>{checking ? 'Cargando…' : KEEP_RULE}</p>
            <Button variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
          </>
        ) : (
          <>
            <p style={helpStyle}>Se pidió antes de la nueva regla: termínala como siempre.</p>
            <div role="radiogroup" aria-label="Cómo se devuelve" style={methodRowStyle}>
              <MethodOption
                active={method === 'CASH'}
                title={preview ? `Efectivo · ${formatEur(preview.cashOutCents)}` : 'Efectivo'}
                text="Se lo das ahora, de la caja de este local (solo lo que entró en efectivo)."
                onClick={() => setMethod('CASH')}
              />
              <MethodOption
                active={method === 'CARD'}
                disabled={!canCard}
                title={preview && canCard ? `A su tarjeta · ${formatEur(preview.cardRefundCents)}` : 'A su tarjeta'}
                text={
                  !isOwner
                    ? 'Solo el dueño.'
                    : canCard
                      ? 'Lo devuelves en el portal de BBVA (lo que entró con tarjeta).'
                      : 'Desde el local donde cargó el saldo.'
                }
                onClick={() => setMethod('CARD')}
              />
            </div>

            {canPay ? null : (
              <p style={{ ...helpStyle, color: 'var(--np-warning)' }}>
                Esta devolución a la tarjeta quedó a medias: la termina el dueño.
              </p>
            )}

            {previewError ? (
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
                  No se ha podido calcular lo que se devuelve: {previewError}
                </p>
                <Button variant="ghost" onClick={reloadPreview}>
                  Reintentar
                </Button>
              </div>
            ) : !plan ? (
              <p style={helpStyle}>Calculando lo que se devuelve…</p>
            ) : plan.blocked ? (
              <p style={{ ...helpStyle, color: 'var(--np-warning)' }}>{plan.blocked}</p>
            ) : (
              <>
                <p style={helpStyle}>{plan.instruction}</p>
                {plan.remainder ? <p style={{ ...helpStyle, color: 'var(--np-warning)' }}>{plan.remainder}</p> : null}
                {method === 'CARD' ? (
                  <Input
                    label="Referencia de la devolución en BBVA"
                    value={bankReference}
                    onChange={(e) => setBankReference(e.target.value)}
                    maxLength={60}
                  />
                ) : null}
              </>
            )}

            <label htmlFor={noteId} style={visuallyHidden}>
              Nota (opcional)
            </label>
            <textarea
              id={noteId}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Nota (opcional)"
              rows={2}
              maxLength={300}
              style={textareaStyle}
            />
            {canPay && amountCents > 0 ? (
              <ConfirmLine>
                {walletPayoutSummary({
                  amountCents,
                  method,
                  code: target.code,
                  venueName: venue.name ?? venue.slug,
                })}
              </ConfirmLine>
            ) : null}
            {withCode ? (
              <OtpInput
                label="Código de tu app de verificación (2FA)"
                value={totp}
                onChange={setTotp}
                lockedUntil={lockedUntil}
                required
                hint={
                  isOwner
                    ? 'Son los 6 números de tu app de verificación. Si aún no la tienes, actívala en Ajustes → Verificación en dos pasos.'
                    : 'Devolver en efectivo desde el umbral del local pide los 6 números de tu app de verificación. Si aún no la tienes, actívala en Ajustes → Verificación en dos pasos.'
                }
              />
            ) : null}
            {error ? (
              <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
                {error}
              </p>
            ) : null}
            <div className="np-pregunta-pie">
              <Button variant="ghost" size="lg" onClick={onClose} disabled={submitting}>
                Volver
              </Button>
              <Button
                variant="danger"
                size="lg"
                onClick={handleSubmit}
                loading={submitting}
                disabled={!canPay || amountCents <= 0 || (withCode && locked)}
              >
                {amountCents > 0 ? `Devolver ${formatEur(amountCents)}` : 'Devolver'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * El cliente no puede pagar con su móvil (sin batería, móvil antiguo): el
 * encargado cobra de su saldo un cobro con QR que hizo la chica. La parte de
 * la chica queda como siempre y queda registrado quién lo aprobó.
 */
export function ChargeWithoutFaceIdModal({
  target,
  onClose,
  onDone,
}: {
  target: PayoutTarget;
  onClose: () => void;
  onDone: () => void;
}) {
  const tz = useVenueTimezone();
  const [pending, setPending] = useState<PendingQrCharge[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [totp, setTotp] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchPendingQrCharges()
      .then((list) => {
        if (!cancelled) setPending(list);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  async function handleApprove() {
    if (!chosen) return;
    if (!/^\d{6}$/.test(totp)) return setError('Pon los 6 números de tu app de verificación.');
    setBusy(true);
    setError(null);
    try {
      await approveQrCharge(chosen, target.walletId, totp);
      onDone();
    } catch (err) {
      const until = totpLockedUntil(err, Date.now());
      if (until !== null) setLockedUntil(until);
      setTotp('');
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => undefined : onClose} title="Cobrar sin Face ID">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={summaryStyle}>
          <p style={{ margin: 0, fontSize: '0.875rem' }}>
            Saldo del cliente: <strong className="np-num">{formatEur(target.balanceCents)}</strong>
          </p>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
            {[target.code, target.label].filter(Boolean).join(' · ')}
          </p>
        </div>
        <p style={helpStyle}>
          Para el cliente que no puede pagar con su móvil (sin batería, móvil antiguo). Elige el cobro que le ha hecho la
          compañera: se descuenta de este saldo con tu código 2FA, queda registrado que lo aprobaste tú y avisa al dueño.
        </p>
        {pending === null ? (
          error ? null : <p style={helpStyle}>Cargando cobros pendientes…</p>
        ) : pending.length === 0 ? (
          <p style={helpStyle}>No hay cobros con QR pendientes. Que la compañera genere el cobro en su móvil y vuelve aquí.</p>
        ) : (
          <div role="radiogroup" aria-label="Cobro a aprobar" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {pending.map((p) => (
              <MethodOption
                key={p.id}
                active={chosen === p.id}
                disabled={p.amountCents > target.balanceCents}
                title={`${formatEur(p.amountCents)}${p.serviceName ? ` · ${p.serviceName}` : ''}`}
                text={`${p.requestedByName} · ${formatDateTime(p.createdAt, tz, 'time')}${
                  p.amountCents > target.balanceCents ? ' · no le llega el saldo' : ''
                }`}
                onClick={() => setChosen(p.id)}
              />
            ))}
          </div>
        )}
        {chosen ? (
          <OtpInput
            label="Código de tu app de verificación (2FA)"
            value={totp}
            onChange={setTotp}
            lockedUntil={lockedUntil}
            autoSubmit={false}
            required
            hint="Son los 6 números de tu app de verificación. Si aún no la tienes, actívala en Ajustes → Verificación en dos pasos."
          />
        ) : null}
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {pending === null && error ? (
            <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
              Reintentar
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={handleApprove} loading={busy} disabled={!chosen || locked}>
            Cobrar del saldo
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Enlace nuevo del saldo: el cliente escanea el QR con su móvil. */
export function RelinkModal({ target, onClose }: { target: PayoutTarget; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; qrDataUrl: string } | null>(null);
  const [totp, setTotp] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);

  async function handleCreate() {
    if (!/^\d{6}$/.test(totp)) return setError('Pon los 6 números de tu app de verificación.');
    setBusy(true);
    setError(null);
    try {
      setLink(await relinkWallet(target.walletId, totp));
    } catch (err) {
      const until = totpLockedUntil(err, Date.now());
      if (until !== null) setLockedUntil(until);
      setTotp('');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => undefined : onClose} title="Enlace nuevo del saldo">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={summaryStyle}>
          <p style={{ margin: 0, fontSize: '0.875rem' }}>
            Saldo: <strong className="np-num">{formatEur(target.balanceCents)}</strong>
          </p>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
            {[target.code, target.label].filter(Boolean).join(' · ')}
          </p>
        </div>
        {link ? (
          <>
            <p style={helpStyle}>
              Que el cliente escanee este QR con su móvil y vuelva a activar Face ID (o elija su PIN) en esa página.
              Vale una sola vez y 10 minutos: si caduca, crea otro enlace nuevo.
            </p>
            <img
              src={link.qrDataUrl}
              alt="QR de activación del saldo (un solo uso)"
              width={240}
              height={240}
              style={{ alignSelf: 'center', borderRadius: 'var(--np-r-md)' }}
            />
            <p style={{ ...helpStyle, wordBreak: 'break-all', fontSize: '0.875rem' }}>{link.url}</p>
            <Button onClick={onClose}>Hecho</Button>
          </>
        ) : (
          <>
            <p style={helpStyle}>
              Para el cliente que perdió su móvil o su página de saldo. El enlace que tenía y su Face ID dejan de
              funcionar; con el enlace nuevo lo activa otra vez en su móvil nuevo.
            </p>
            <OtpInput
              label="Código de tu app de verificación (2FA)"
              value={totp}
              onChange={setTotp}
              lockedUntil={lockedUntil}
              autoSubmit={false}
              required
              hint="Son los 6 números de tu app de verificación. Si aún no la tienes, actívala en Ajustes → Verificación en dos pasos."
            />
            {error ? (
              <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
                {error}
              </p>
            ) : null}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancelar
              </Button>
              <Button onClick={handleCreate} loading={busy} disabled={locked}>
                Crear enlace nuevo
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Borrar el PIN de un cliente que lo olvidó o, con `unlock`, desbloquearlo tras
 * los fallos: con el 2FA de quien lo hace (sale en Incidencias).
 */
export function ResetPinModal({
  walletId,
  code,
  unlock = false,
  onClose,
  onDone,
}: {
  walletId: string;
  code: string | null;
  unlock?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);

  async function handleReset() {
    if (!/^\d{6}$/.test(totp)) return setError('Pon los 6 números de tu app de verificación.');
    setBusy(true);
    setError(null);
    try {
      await (unlock ? unlockWalletPin(walletId, totp) : resetWalletPin(walletId, totp));
      onDone();
    } catch (err) {
      const until = totpLockedUntil(err, Date.now());
      if (until !== null) setLockedUntil(until);
      setTotp('');
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => undefined : onClose} title={unlock ? 'Desbloquear PIN' : 'Borrar PIN'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <p style={helpStyle}>
          {unlock
            ? `Vas a desbloquear el PIN de ${code ?? 'este saldo'}. Comprueba antes que el cliente está delante: podrá volver a pagar con su PIN.`
            : `Vas a borrar el PIN de ${code ?? 'este saldo'}. Comprueba antes que el cliente está delante: elegirá uno nuevo contigo.`}
        </p>
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={totp}
          onChange={setTotp}
          lockedUntil={lockedUntil}
          autoSubmit={false}
          required
          hint="Son los 6 números de tu app de verificación. Si aún no la tienes, actívala en Ajustes → Verificación en dos pasos."
        />
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={handleReset} loading={busy} disabled={locked}>
            {unlock ? 'Desbloquear PIN' : 'Borrar PIN'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MethodOption({
  active,
  disabled = false,
  title,
  text,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...methodStyle,
        // Lo elegido en t1 (la lima es para el botón); sin opacidad al no poderse.
        borderColor: active ? 'var(--np-text)' : 'var(--np-border-hi)',
        boxShadow: active ? 'inset 0 0 0 1px var(--np-text)' : undefined,
        color: disabled ? 'var(--np-disabled-ink)' : undefined,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ fontWeight: 600 }}>{title}</span>
      <span style={{ fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>{text}</span>
    </button>
  );
}

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  fontWeight: 600,
};

const summaryStyle: CSSProperties = {
  padding: '0.75rem 1rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
};

const methodRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '0.5rem',
};

const methodStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.25rem',
  padding: '0.75rem',
  textAlign: 'left',
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-sm)',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
};

const linkStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: 0,
  background: 'transparent',
  border: 'none',
  color: 'var(--np-text)',
  fontSize: '0.875rem',
  fontFamily: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
};

const helpStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
  lineHeight: 1.45,
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

/** Etiqueta para lectores de pantalla sin ocupar sitio (el campo ya lleva placeholder). */
const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
