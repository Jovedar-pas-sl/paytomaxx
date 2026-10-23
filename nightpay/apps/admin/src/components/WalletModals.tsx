'use client';

import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Modal } from '@nightpay/ui';
import {
  approveQrCharge,
  fetchPendingQrCharges,
  lookupWalletCode,
  payoutWallet,
  relinkWallet,
  type PendingQrCharge,
  type WalletPayoutMethod,
} from '@/lib/api';
import { totpRetryState } from '@/lib/api-errors';
import { walletPayoutSummary } from '@/lib/confirm-summary';
import { payoutDoneText } from '@/lib/wallet-payout';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { useLockActive } from '@/lib/use-lock';
import { useVenue, useVenueTimezone } from '@/lib/venue-context';
import { ConfirmLine } from './ConfirmLine';
import { OtpInput } from './OtpInput';

/** Saldo a devolver: de la lista o encontrado por el código del cliente. */
export interface PayoutTarget {
  walletId: string;
  code: string | null;
  balanceCents: number;
  label: string | null;
  /** Cargado en este local: solo desde aquí se apunta la devolución a la tarjeta. */
  isHomeVenue: boolean;
  /** El cliente pulsó "Me voy" (sin eso, solo el dueño devuelve). */
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
      <h3 style={sectionTitle}>Devolver el saldo a un cliente que se va</h3>
      <p style={{ margin: '0.25rem 0 0.75rem', fontSize: '0.8rem', color: 'var(--np-text-mute)' }}>
        Pon el código que sale en su página de saldo (vale aunque cargara en otro local).
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        <Input
          aria-label="Código del cliente"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
          placeholder="K7Q4M2"
          autoComplete="off"
          spellCheck={false}
          style={{ letterSpacing: '0.2em', fontWeight: 700 }}
        />
        <Button type="submit" loading={busy} disabled={code.length !== 6}>
          Buscar
        </Button>
      </form>
      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
          {error}
        </p>
      ) : null}
    </Card>
  );
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
  // Sin el "Me voy" del cliente, solo el dueño puede devolver.
  const canPay = isOwner || target.closeRequested;
  const [bankReference, setBankReference] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** El encargado en efectivo desde el umbral del local: el API pide su código 2FA. */
  const [askedForCode, setAskedForCode] = useState(false);
  const [totp, setTotp] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);
  const venue = useVenue();
  const amount = formatEur(target.balanceCents);
  const withCode = askedForCode && method === 'CASH';

  async function handleSubmit() {
    if (submitting) return;
    if (withCode && !/^\d{6}$/.test(totp)) return setError('Pon los 6 números de tu app de verificación.');
    setSubmitting(true);
    setError(null);
    try {
      const res = await payoutWallet(target.walletId, {
        method,
        bankReference: method === 'CARD' ? bankReference.trim() || undefined : undefined,
        note: note.trim() || undefined,
        totpCode: withCode ? totp : undefined,
      });
      // En efectivo puede salir solo una parte (lo que entró en efectivo): se dice lo que queda.
      setDone(payoutDoneText(res));
    } catch (err) {
      const retry = totpRetryState(err, Date.now());
      if (retry.lockedUntil !== null) setLockedUntil(retry.lockedUntil);
      if (retry.askCode) setAskedForCode(true);
      setTotp('');
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title="Devolver saldo">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={summaryStyle}>
          <p style={{ margin: 0, fontSize: '0.85rem' }}>
            Saldo a devolver: <strong className="np-num">{amount}</strong>
          </p>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
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
        ) : (
          <>
            <div role="radiogroup" aria-label="Cómo se devuelve" style={methodRowStyle}>
              <MethodOption
                active={method === 'CASH'}
                title="Efectivo"
                text="Se lo das ahora, de la caja de este local (solo lo que entró en efectivo)."
                onClick={() => setMethod('CASH')}
              />
              <MethodOption
                active={method === 'CARD'}
                disabled={!canCard}
                title="A su tarjeta"
                text={
                  !isOwner
                    ? 'Solo el dueño.'
                    : canCard
                      ? 'Lo devuelves en el portal de BBVA.'
                      : 'Desde el local donde cargó el saldo.'
                }
                onClick={() => setMethod('CARD')}
              />
            </div>

            {canPay ? null : (
              <p style={{ ...helpStyle, color: 'var(--np-warning)' }}>
                El cliente aún no ha pulsado «Me voy» en su página de saldo. Pídeselo, o que lo devuelva el dueño.
              </p>
            )}

            {method === 'CASH' ? (
              <p style={helpStyle}>Dale {amount} al cliente y confirma. El saldo queda cerrado.</p>
            ) : (
              <>
                <p style={helpStyle}>
                  1. En el portal de BBVA, devuelve {amount} a las recargas de saldo del cliente (la más reciente
                  primero). 2. Pon la referencia de la devolución y confirma: aquí se apunta igual, repartido entre
                  sus recargas.
                </p>
                <Input
                  label="Referencia de la devolución en BBVA"
                  value={bankReference}
                  onChange={(e) => setBankReference(e.target.value)}
                  maxLength={60}
                />
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
            {canPay ? (
              <ConfirmLine>
                {walletPayoutSummary({
                  amountCents: target.balanceCents,
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
                hint="Devolver en efectivo desde el umbral del local pide los 6 números de tu app de verificación. Si aún no la tienes, actívala en Ajustes → Verificación en dos pasos."
              />
            ) : null}
            {error ? (
              <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>
                {error}
              </p>
            ) : null}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                Cancelar
              </Button>
              <Button onClick={handleSubmit} loading={submitting} disabled={!canPay || (withCode && locked)}>
                Devolver {amount}
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
    setBusy(true);
    setError(null);
    try {
      await approveQrCharge(chosen, target.walletId);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => undefined : onClose} title="Cobrar sin Face ID">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={summaryStyle}>
          <p style={{ margin: 0, fontSize: '0.85rem' }}>
            Saldo del cliente: <strong className="np-num">{formatEur(target.balanceCents)}</strong>
          </p>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
            {[target.code, target.label].filter(Boolean).join(' · ')}
          </p>
        </div>
        <p style={helpStyle}>
          Para el cliente que no puede pagar con su móvil (sin batería, móvil antiguo). Elige el cobro que le ha hecho la
          chica: se descuenta de este saldo y queda registrado que lo aprobaste tú.
        </p>
        {pending === null ? (
          error ? null : <p style={helpStyle}>Cargando cobros pendientes…</p>
        ) : pending.length === 0 ? (
          <p style={helpStyle}>No hay cobros con QR pendientes. Que la chica genere el cobro en su móvil y vuelve aquí.</p>
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
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>
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
          <Button onClick={handleApprove} loading={busy} disabled={!chosen}>
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

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      setLink(await relinkWallet(target.walletId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => undefined : onClose} title="Enlace nuevo del saldo">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={summaryStyle}>
          <p style={{ margin: 0, fontSize: '0.85rem' }}>
            Saldo: <strong className="np-num">{formatEur(target.balanceCents)}</strong>
          </p>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
            {[target.code, target.label].filter(Boolean).join(' · ')}
          </p>
        </div>
        {link ? (
          <>
            <p style={helpStyle}>
              Que el cliente escanee este QR con su móvil y vuelva a activar Face ID en esa página. Es su saldo.
            </p>
            <img
              src={link.qrDataUrl}
              alt="QR del enlace del saldo"
              width={240}
              height={240}
              style={{ alignSelf: 'center', borderRadius: 'var(--np-r-md)' }}
            />
            <p style={{ ...helpStyle, wordBreak: 'break-all', fontSize: '0.72rem' }}>{link.url}</p>
            <Button onClick={onClose}>Hecho</Button>
          </>
        ) : (
          <>
            <p style={helpStyle}>
              Para el cliente que perdió su móvil o su página de saldo. El enlace que tenía y su Face ID dejan de
              funcionar; con el enlace nuevo lo activa otra vez en su móvil nuevo.
            </p>
            {error ? (
              <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>
                {error}
              </p>
            ) : null}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancelar
              </Button>
              <Button onClick={handleCreate} loading={busy}>
                Crear enlace nuevo
              </Button>
            </div>
          </>
        )}
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
        borderColor: active ? 'var(--np-accent)' : 'var(--np-border)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ fontWeight: 700 }}>{title}</span>
      <span style={{ fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>{text}</span>
    </button>
  );
}

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  fontWeight: 600,
  letterSpacing: '-0.01em',
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
  border: '2px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
};

const linkStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: 0,
  background: 'transparent',
  border: 'none',
  color: 'var(--np-text)',
  fontSize: '0.8125rem',
  fontFamily: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
};

const helpStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.82rem',
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
