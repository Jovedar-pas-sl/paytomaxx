'use client';

import { useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Button } from '@nightpay/ui';
import type { PayoutAccountFull } from '@nightpay/contracts';
import { revealOperatorPayoutAccount, type PayoutMethod } from '@/lib/api';
import { ApiError, totpLockedUntil } from '@/lib/api-errors';
import { OTP_LENGTH } from '@/lib/otp';
import { REVEAL_PAYOUT_SECONDS, holderMismatchText, revealLeft, twoFactorNeededText } from '@/lib/payout-account-view';
import { useTwoFactorEnabled } from '@/lib/use-two-factor';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';
import { PAYOUT_METHOD_LABELS } from './PayoutMethodForm';

interface Props {
  operatorId: string;
  /** Su nombre en el panel (para el aviso del titular). */
  personName: string | null;
  method: PayoutMethod | null;
  /** La cuenta tapada (lo único que llega en las listas). */
  masked: string | null;
  holderMasked?: string | null;
  holderMismatch?: boolean;
  label: string | null;
  /** «Ver cuenta para pagar»: solo el dueño (el API lo exige y pide su 2FA). */
  canReveal: boolean;
  /** La cuenta entera mientras está a la vista (null al taparse). */
  onRevealed?: (account: PayoutAccountFull | null) => void;
}

/**
 * La cuenta de cobro de una compañera en «Marcar pagado»: tapada; el dueño
 * la ve entera con «Ver cuenta para pagar» (su código 2FA) durante un minuto,
 * con «Copiar». Queda en el registro (sin la cuenta en claro).
 */
export function PayoutAccountBox({
  operatorId,
  personName,
  method,
  masked,
  holderMasked,
  holderMismatch,
  label,
  canReveal,
  onRevealed,
}: Props) {
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [shown, setShown] = useState<{ account: PayoutAccountFull; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Sin la 2FA activada no se ve entera: se dice en vez de pedir un código que no tiene.
  const without2fa = useTwoFactorEnabled(asking) === false;

  // A la vista, un minuto: luego se tapa sola.
  useEffect(() => {
    if (!shown) return undefined;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= shown.until) hide();
    }, 1000);
    return () => clearInterval(timer);
  }, [shown]);

  // Con el sexto número, se pide (como el resto del panel); una vez por código.
  useEffect(() => {
    if (asking && code.length === OTP_LENGTH && !busy) void reveal(code);
  }, [code]);

  function hide() {
    setShown(null);
    onRevealed?.(null);
  }

  async function reveal(totpCode: string) {
    if (busy || totpCode.length !== OTP_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      const account = await revealOperatorPayoutAccount(operatorId, totpCode);
      const at = Date.now();
      setNow(at);
      setShown({ account, until: at + REVEAL_PAYOUT_SECONDS * 1000 });
      onRevealed?.(account);
      setAsking(false);
    } catch (err) {
      const lockEnds = totpLockedUntil(err, Date.now());
      if (lockEnds !== null) setLockedUntil(lockEnds);
      if (lockEnds !== null || (err instanceof ApiError && err.code === 'TOTP_INVALID')) setCode('');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Intro en el código: pedir la cuenta, no enviar el formulario del pago.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    void reveal(code);
  }

  const full = shown?.account ?? null;
  const holder = full?.payoutMetadata?.accountHolder ?? null;

  return (
    <div style={box}>
      <p style={kicker}>Cuenta de cobro de la compañera</p>
      {method ? (
        <p style={{ margin: '0.25rem 0 0' }}>
          <strong>{PAYOUT_METHOD_LABELS[method]}</strong>
        </p>
      ) : null}
      {full ? (
        <>
          {full.payoutAddress ? <CopyLine text={full.payoutAddress} /> : null}
          {holder ? <CopyLine text={holder} prefix="Titular: " /> : null}
          {full.payoutMetadata?.bankName ? <CopyLine text={full.payoutMetadata.bankName} prefix="Banco: " /> : null}
          {full.payoutMetadata?.swiftBic ? <CopyLine text={full.payoutMetadata.swiftBic} prefix="SWIFT/BIC: " /> : null}
          <p style={dim} aria-live="polite">
            Se tapa en {revealLeft(shown!.until, now)} s ·{' '}
            <button type="button" style={linkBtn} onClick={hide}>
              Tapar ya
            </button>
          </p>
        </>
      ) : (
        <>
          {masked ? <p style={mono}>{masked}</p> : null}
          {holderMasked ? <p style={dim}>Titular: {holderMasked}</p> : null}
        </>
      )}
      {label ? <p style={dim}>Alias: {label}</p> : null}
      {holderMismatch ? (
        <Notice tone="warning" style={{ marginTop: '0.5rem' }}>
          {holderMismatchText(personName)}
        </Notice>
      ) : null}

      {canReveal && masked && !full ? (
        asking && without2fa ? (
          <Notice tone="warning" style={{ marginTop: '0.5rem' }}>
            {twoFactorNeededText('reveal')}
          </Notice>
        ) : asking ? (
          <div style={{ marginTop: '0.75rem' }} onKeyDownCapture={onKeyDown}>
            <OtpInput
              label="Tu código 2FA para ver la cuenta entera"
              value={code}
              onChange={setCode}
              lockedUntil={lockedUntil}
              disabled={busy}
              autoFocus
              hint="Se ve un minuto y queda en el registro (sin la cuenta)."
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <Button type="button" size="sm" loading={busy} onClick={() => void reveal(code)}>
                Ver cuenta
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
                No
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="ghost" size="sm" style={{ marginTop: '0.5rem' }} onClick={() => setAsking(true)}>
            Ver cuenta para pagar
          </Button>
        )
      ) : null}
      {!canReveal && masked ? <p style={dim}>Solo el dueño puede ver la cuenta entera.</p> : null}
      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CopyLine({ text, prefix }: { text: string; prefix?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p style={mono}>
      {prefix ? <span style={{ fontFamily: 'inherit' }}>{prefix}</span> : null}
      {text}
      <button
        type="button"
        style={copyBtn}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </p>
  );
}

const box: CSSProperties = {
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  padding: '0.75rem 1rem',
  fontSize: '0.875rem',
};

const kicker: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem', fontWeight: 400 };

const mono: CSSProperties = {
  margin: '0.25rem 0 0',
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.875rem',
  color: 'var(--np-text)',
  wordBreak: 'break-all',
};

const dim: CSSProperties = { margin: '0.25rem 0 0', fontSize: '0.875rem', color: 'var(--np-text-dim)' };

const copyBtn: CSSProperties = {
  marginLeft: '0.5rem',
  minHeight: '2rem',
  background: 'none',
  border: '1px solid var(--np-border)',
  color: 'var(--np-text-mute)',
  fontSize: '0.875rem',
  padding: '0.15rem 0.5rem',
  borderRadius: '4px',
  cursor: 'pointer',
};

const linkBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--np-text-mute)',
  textDecoration: 'underline',
  fontSize: '0.875rem',
  cursor: 'pointer',
};
