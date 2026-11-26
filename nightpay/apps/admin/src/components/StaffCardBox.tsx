'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { staffCardNumberText, type StaffCardView } from '@nightpay/contracts';
import { issueStaffCard, reserveStaffCardCode, revokeStaffCard } from '@/lib/api';
import { NO_WEB_NFC, webNfcWriter, writeStaffCard } from '@/lib/staff-card-nfc';
import { Notice } from './Notice';

/**
 * Su ficha NFC en su hoja (cobro por el encargado, fase 2): «Ficha nº 0522»,
 * darle una (o otra, si la perdió: la de antes deja de valer al momento) y
 * anularla. Se graba aquí mismo con un Android con Chrome, en una ficha en
 * blanco, como las de los clientes: el código lo da el servidor antes de
 * acercarla. Si se grabó y falló al darla (red), se acerca la misma otra vez.
 */
export function StaffCardBox({
  operatorId,
  name,
  initial,
  onChanged,
}: {
  operatorId: string;
  name: string;
  initial: StaffCardView | null;
  onChanged: () => void;
}) {
  const [card, setCard] = useState<StaffCardView | null>(initial);
  const [writing, setWriting] = useState<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  useEffect(() => setCanWrite(webNfcWriter() !== null), []);
  useEffect(() => () => writing?.abort(), [writing]);

  async function give(): Promise<void> {
    const Reader = webNfcWriter();
    if (!Reader) return setError(NO_WEB_NFC);
    const ctrl = new AbortController();
    setWriting(ctrl);
    setError(null);
    setNote(null);
    try {
      const code = await reserveStaffCardCode(operatorId);
      const written = await writeStaffCard(Reader, window.location.origin, ctrl.signal, code);
      const before = card;
      let next: StaffCardView;
      try {
        next = await issueStaffCard(operatorId, { card: written.card, uid: written.uid });
      } catch (err) {
        // Grabada pero sin darla (red, tiempo): la misma ficha vale al reintentar.
        throw written.written ? new Error(`${(err as Error).message} La ficha ya está grabada: pulsa otra vez y acerca la misma.`) : err;
      }
      setCard(next);
      setNote(
        before && before.number === next.number
          ? `Esa ya es su ficha nº ${staffCardNumberText(next.number)}.`
          : before
            ? `Ficha nº ${staffCardNumberText(next.number)} dada. La nº ${staffCardNumberText(before.number)} ya no vale.`
            : `Ficha nº ${staffCardNumberText(next.number)} dada a ${name}.`,
      );
      onChanged();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      ctrl.abort();
      setWriting(null);
    }
  }

  async function revoke(): Promise<void> {
    if (!card || busy) return;
    if (!window.confirm(`¿Anular la ficha nº ${staffCardNumberText(card.number)} de ${name}? Deja de valer al momento.`)) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await revokeStaffCard(operatorId);
      setCard(null);
      setNote('Ficha anulada: ya no vale.');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={box} aria-label="Su ficha NFC">
      <div style={row}>
        <b>{card ? `Ficha nº ${staffCardNumberText(card.number)}` : 'Sin ficha'}</b>
        <span style={mute}>{card ? 'Se acerca al cobrar sus servicios, además de su «Mi QR».' : 'Con ficha, quien cobra a su nombre la acerca en lugar de escanear su «Mi QR».'}</span>
      </div>
      <div style={actions}>
        {writing ? (
          <Button variant="ghost" size="sm" onClick={() => writing.abort()}>
            Acerca una ficha en blanco… (cancelar)
          </Button>
        ) : (
          <Button variant="ghost" size="sm" disabled={!canWrite} onClick={() => void give()}>
            {card ? 'Darle otra ficha' : 'Darle su ficha'}
          </Button>
        )}
        {card ? (
          <Button variant="ghost" size="sm" loading={busy} onClick={() => void revoke()}>
            Anular ficha
          </Button>
        ) : null}
      </div>
      {!canWrite ? <span style={mute}>{NO_WEB_NFC}</span> : null}
      {note ? <Notice tone="success">{note}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </section>
  );
}

const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 0' };
const row: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.125rem' };
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' };
const mute: CSSProperties = { color: 'var(--np-text-mute)', fontSize: 'var(--np-fs-14)' };
