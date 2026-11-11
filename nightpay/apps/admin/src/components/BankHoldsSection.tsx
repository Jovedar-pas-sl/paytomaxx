'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input } from '@nightpay/ui';
import type { BankHoldList, BankHoldSale } from '@nightpay/contracts';
import { fetchBankHolds, releaseBankHold } from '@/lib/api';
import { ApiError, totpLockedUntil } from '@/lib/api-errors';
import { bankHoldLine, releaseBlockText, releaseConfirmText, releaseErrorText, saleVia } from '@/lib/bank-holds';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { useLockActive } from '@/lib/use-lock';
import { useVenueTimezone } from '@/lib/venue-context';
import { ConfirmLine } from './ConfirmLine';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';

interface Props {
  operatorId: string;
  /** «Ana»: para la confirmación. */
  name: string;
  balance: { bankHeldCents?: number; bankHeldCount?: number };
  /** Se liberó una: refrescar el saldo (lo que se le paga). */
  onReleased: () => void;
}

/**
 * «Pendiente de cuadrar con el banco» en la ficha de la chica (H-1): sus
 * ventas por datáfono sin prueba del banco. Su parte no entra en el pago
 * hasta que el fichero del banco las case o el dueño las libere aquí, una a
 * una y con su 2FA (nunca la suya: el API lo impide y aquí se dice).
 */
export function BankHoldsSection({ operatorId, name, balance, onReleased }: Props) {
  const line = bankHoldLine(balance);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BankHoldList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<BankHoldSale | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const tz = useVenueTimezone();

  async function load(): Promise<void> {
    setError(null);
    try {
      setList(await fetchBankHolds(operatorId));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    if (open && list === null) void load();
  }, [open]);

  if (!line && !done) return null;

  return (
    <section style={boxStyle} aria-label="Ventas por datáfono pendientes de cuadrar con el banco">
      {line ? (
        <p style={{ margin: 0, fontWeight: 600 }}>
          {line}
          <span style={hintStyle}> · no entra en el pago hasta cuadrarlas con el fichero del banco o liberarlas.</span>
        </p>
      ) : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      {line ? (
        <Button variant="ghost" type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Ocultar las ventas' : 'Ver las ventas'}
        </Button>
      ) : null}
      {open ? (
        error ? (
          <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => void load() }}>
            {error}
          </Notice>
        ) : list === null ? (
          <p className="np-ficha-empty">Cargando…</p>
        ) : list.sales.length === 0 ? (
          <p className="np-ficha-empty">Ya no hay ventas pendientes de cuadrar.</p>
        ) : (
          <ul style={listStyle}>
            {list.sales.map((sale) =>
              releasing?.paymentId === sale.paymentId ? (
                <ReleaseForm
                  key={sale.paymentId}
                  sale={sale}
                  name={name}
                  onCancel={() => setReleasing(null)}
                  onDone={(text) => {
                    setReleasing(null);
                    setDone(text);
                    setList(null);
                    void load();
                    onReleased();
                  }}
                />
              ) : (
                <li key={sale.paymentId} style={itemStyle}>
                  <span style={{ minWidth: 0 }}>
                    <b className="np-num">{formatEur(sale.shareCents)}</b> de {sale.ref ?? 'un cobro'} de{' '}
                    <span className="np-num">{formatEur(sale.chargedCents)}</span>
                    <span style={metaStyle}>
                      {formatDateTime(sale.at, tz, 'datetime')} · {saleVia(sale)}
                    </span>
                    {sale.releaseBlock ? <span style={metaStyle}>{releaseBlockText(sale.releaseBlock)}</span> : null}
                  </span>
                  {sale.releaseBlock === null ? (
                    <Button type="button" onClick={() => setReleasing(sale)} disabled={releasing !== null}>
                      Liberar
                    </Button>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        )
      ) : null}
    </section>
  );
}

/** «Liberar» una venta: lo que se da por bueno, la nota y el código 2FA (al sexto número se envía). */
function ReleaseForm({
  sale,
  name,
  onCancel,
  onDone,
}: {
  sale: BankHoldSale;
  name: string;
  onCancel: () => void;
  onDone: (text: string) => void;
}) {
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [otpKey, setOtpKey] = useState(0);
  const inFlight = useRef(false);
  const locked = useLockActive(lockedUntil);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (inFlight.current) return;
    if (!/^\d{6}$/.test(code)) return setError('Pon los 6 números de tu app de verificación.');
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await releaseBankHold(sale.paymentId, { totpCode: code, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone(
        result.status === 'MATCHED'
          ? 'Esa venta ya está cuadrada con el banco: su comisión se paga sola.'
          : `Liberada: ${formatEur(sale.shareCents)} de ${name} entran en su próximo pago.`,
      );
    } catch (err) {
      const lockEnds = totpLockedUntil(err, Date.now());
      if (lockEnds !== null) setLockedUntil(lockEnds);
      if (err instanceof ApiError && (err.code === 'TOTP_INVALID' || lockEnds !== null)) {
        setCode('');
        setOtpKey((k) => k + 1);
      }
      setError(releaseErrorText(err instanceof ApiError ? { code: err.code, message: err.message } : { message: (err as Error).message }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <li style={{ ...itemStyle, flexDirection: 'column', alignItems: 'stretch' }}>
      <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <ConfirmLine>{releaseConfirmText(sale, name)}</ConfirmLine>
        <Input
          label="Nota (opcional): cómo lo has comprobado"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          placeholder="ej: visto en el extracto de BBVA"
        />
        <OtpInput
          key={otpKey}
          label="Código de tu app de verificación (2FA)"
          value={code}
          onChange={setCode}
          autoSubmit
          autoFocus
          required
          disabled={busy}
          lockedUntil={lockedUntil}
          hint="Al poner el sexto número se libera. Cada código vale una sola vez."
        />
        {error ? (
          <p role="alert" style={{ margin: 0, color: 'var(--np-danger)', fontSize: '1rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button type="submit" loading={busy} disabled={locked}>
            Liberar {formatEur(sale.shareCents)}
          </Button>
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
        </div>
      </form>
    </li>
  );
}

const boxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  padding: '0.875rem 1rem',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-warning)',
  background: 'color-mix(in srgb, var(--np-warning) 8%, transparent)',
};

const hintStyle: CSSProperties = { fontWeight: 400, color: 'var(--np-text-label)' };

const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' };

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  padding: '0.625rem 0.75rem',
  borderRadius: 'var(--np-r-sm)',
  background: 'var(--np-surface-2)',
  fontSize: '1rem',
};

const metaStyle: CSSProperties = { display: 'block', marginTop: '0.125rem', color: 'var(--np-text-label)', fontSize: '0.875rem' };
