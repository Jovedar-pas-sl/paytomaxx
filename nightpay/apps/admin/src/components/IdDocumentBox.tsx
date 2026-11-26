'use client';

import { useEffect, useId, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Button, Input, Select } from '@nightpay/ui';
import {
  ID_DOCUMENT_TYPES,
  ID_DOCUMENT_TYPE_LABEL,
  idDocumentProblem,
  normalizeIdDocumentNumber,
  type IdDocumentFull,
  type IdDocumentType,
} from '@nightpay/contracts';
import { revealOperatorIdDocument, updateOperator } from '@/lib/api';
import { ApiError, totpLockedUntil } from '@/lib/api-errors';
import { OTP_LENGTH } from '@/lib/otp';
import { REVEAL_PAYOUT_SECONDS, revealLeft } from '@/lib/payout-account-view';
import { useTwoFactorEnabled } from '@/lib/use-two-factor';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';

const NEEDS_2FA = 'Para ver el documento entero hace falta la verificación en dos pasos (2FA). Actívala en Ajustes → Seguridad y vuelve aquí.';

/**
 * Su documento (DNI, NIE o pasaporte), cifrado (cobro por el encargado, fase
 * 3): aquí tapado («DNI •••• 678Z»). El encargado y el dueño lo ponen o lo
 * cambian; entero, solo el dueño con su 2FA, un minuto, y queda en el registro.
 * Va dentro del formulario de Onboarding, pero se guarda aparte.
 */
export function IdDocumentBox({
  operatorId,
  type,
  masked,
  isOwner,
  onSaved,
}: {
  operatorId: string;
  type: IdDocumentType | null;
  masked: string | null;
  isOwner: boolean;
  onSaved: () => void;
}) {
  const typeId = useId();
  const [current, setCurrent] = useState<{ type: IdDocumentType | null; masked: string | null }>({ type, masked });
  const [editing, setEditing] = useState(false);
  const [draftType, setDraftType] = useState<IdDocumentType>(type ?? 'DNI');
  const [draftNumber, setDraftNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [shown, setShown] = useState<{ doc: IdDocumentFull; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const without2fa = useTwoFactorEnabled(asking) === false;

  // A la vista, un minuto: luego se tapa solo.
  useEffect(() => {
    if (!shown) return undefined;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= shown.until) setShown(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [shown]);

  useEffect(() => {
    if (asking && code.length === OTP_LENGTH && !busy) void reveal(code);
  }, [code]);

  async function save(doc: { type: IdDocumentType; number: string } | null): Promise<void> {
    if (busy) return;
    if (doc) {
      const problem = idDocumentProblem(doc.type, doc.number);
      if (problem) return setError(problem);
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateOperator(operatorId, { idDocument: doc });
      setCurrent({ type: updated.idDocumentType ?? null, masked: updated.idDocumentMasked ?? null });
      setShown(null);
      setEditing(false);
      setDraftNumber('');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reveal(totpCode: string): Promise<void> {
    if (busy || totpCode.length !== OTP_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      const doc = await revealOperatorIdDocument(operatorId, totpCode);
      const at = Date.now();
      setNow(at);
      setShown({ doc, until: at + REVEAL_PAYOUT_SECONDS * 1000 });
      setAsking(false);
      setCode('');
    } catch (err) {
      const lockEnds = totpLockedUntil(err, Date.now());
      if (lockEnds !== null) setLockedUntil(lockEnds);
      if (lockEnds !== null || (err instanceof ApiError && err.code === 'TOTP_INVALID')) setCode('');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Intro aquí: guardar o ver el documento, no enviar el formulario de Onboarding.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (editing) void save({ type: draftType, number: normalizeIdDocumentNumber(draftNumber) });
    else if (asking) void reveal(code);
  }

  return (
    <div style={box} onKeyDownCapture={onKeyDown}>
      <p style={kicker}>Documento (cifrado)</p>
      {shown ? (
        <>
          <p style={mono}>
            {ID_DOCUMENT_TYPE_LABEL[shown.doc.type]} {shown.doc.number}
          </p>
          <p style={dim} aria-live="polite">
            Se tapa en {revealLeft(shown.until, now)} s ·{' '}
            <button type="button" style={linkBtn} onClick={() => setShown(null)}>
              Tapar ya
            </button>
          </p>
        </>
      ) : current.masked ? (
        <p style={mono}>{current.type ? `${ID_DOCUMENT_TYPE_LABEL[current.type]} ${current.masked}` : current.masked}</p>
      ) : (
        <p style={dim}>Sin documento.</p>
      )}

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
          <div>
            <label htmlFor={typeId} style={selectLabel}>
              Tipo
            </label>
            <Select id={typeId} value={draftType} onChange={(e) => setDraftType(e.target.value as IdDocumentType)} disabled={busy}>
              {ID_DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ID_DOCUMENT_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </div>
          <Input
            label="Número"
            value={draftNumber}
            onChange={(e) => setDraftNumber(e.target.value.toUpperCase())}
            placeholder={draftType === 'DNI' ? '12345678Z' : draftType === 'NIE' ? 'X1234567L' : ''}
            autoComplete="off"
            hint="Se guarda cifrado. Después solo se ve tapado (el dueño, entero con su 2FA)."
            disabled={busy}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            <Button type="button" size="sm" loading={busy} onClick={() => void save({ type: draftType, number: normalizeIdDocumentNumber(draftNumber) })}>
              Guardar documento
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              No cambiar
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
            {current.masked ? 'Cambiar documento' : 'Poner documento'}
          </Button>
          {current.masked && isOwner ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (window.confirm('¿Quitar su documento? Se borra cifrado y todo.')) void save(null);
              }}
            >
              Quitar documento
            </Button>
          ) : null}
          {current.masked && isOwner && !shown && !asking ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(true)}>
              Ver documento entero
            </Button>
          ) : null}
        </div>
      )}

      {asking && without2fa ? (
        <Notice tone="warning" style={{ marginTop: '0.5rem' }}>
          {NEEDS_2FA}
        </Notice>
      ) : asking ? (
        <div style={{ marginTop: '0.75rem' }}>
          <OtpInput
            label="Tu código 2FA para ver el documento entero"
            value={code}
            onChange={setCode}
            lockedUntil={lockedUntil}
            disabled={busy}
            autoFocus
            hint="Se ve un minuto y queda en el registro (sin el número)."
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <Button type="button" size="sm" loading={busy} onClick={() => void reveal(code)}>
              Ver documento
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
              No
            </Button>
          </div>
        </div>
      ) : null}
      {!isOwner && current.masked ? <p style={dim}>Solo el dueño puede verlo entero.</p> : null}
      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem' };
const kicker: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' };
const mono: CSSProperties = { margin: 0, fontFamily: 'var(--np-font-mono, monospace)', overflowWrap: 'anywhere' };
const dim: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' };
const selectLabel: CSSProperties = { display: 'block', marginBottom: '0.25rem', fontSize: 'var(--np-fs-14)' };
const linkBtn: CSSProperties = { background: 'none', border: 0, padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer' };
