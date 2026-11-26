'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, useConfirm } from '@nightpay/ui';
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
 *
 * Dos toques: «Darle su ficha» pide el código al servidor y «Grabar» arranca
 * el lector NFC. Chrome solo deja empezar a leer dentro de un toque y, si se
 * esperase al servidor en el mismo, con red lenta lo da por perdido
 * (NotAllowedError) y la primera ficha no se podría dar.
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
  const [code, setCode] = useState<string | null>(null);
  const [reserving, setReserving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, dialog] = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  useEffect(() => setCanWrite(webNfcWriter() !== null), []);
  useEffect(() => () => writing?.abort(), [writing]);

  /** Primer toque: el código del servidor, antes de acercar la ficha (sin NFC todavía). */
  async function prepare(): Promise<void> {
    if (reserving) return;
    if (!webNfcWriter()) return setError(NO_WEB_NFC);
    setReserving(true);
    setError(null);
    setNote(null);
    try {
      setCode(await reserveStaffCardCode(operatorId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReserving(false);
    }
  }

  /** Segundo toque: el lector arranca aquí mismo, sin esperar a nada antes. */
  async function give(): Promise<void> {
    const Reader = webNfcWriter();
    if (!Reader) return setError(NO_WEB_NFC);
    if (!code) return;
    const ctrl = new AbortController();
    const pending = writeStaffCard(Reader, window.location.origin, ctrl.signal, code);
    setWriting(ctrl);
    setError(null);
    setNote(null);
    try {
      const written = await pending;
      const before = card;
      let next: StaffCardView;
      try {
        next = await issueStaffCard(operatorId, { card: written.card, uid: written.uid });
      } catch (err) {
        // Grabada pero sin darla (red, tiempo): la misma ficha vale al reintentar.
        throw written.written ? new Error(`${(err as Error).message} La ficha ya está grabada: pulsa «Grabar» otra vez y acerca la misma.`) : err;
      }
      setCard(next);
      setCode(null);
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
    if (!(await confirm({ title: `¿Anular la ficha nº ${staffCardNumberText(card.number)} de ${name}?`, body: 'Deja de valer al momento.', confirmLabel: 'Anular ficha' }))) return;
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
        ) : code ? (
          <>
            <Button size="sm" onClick={() => void give()}>
              Grabar
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCode(null)}>
              Cancelar
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" disabled={!canWrite} loading={reserving} onClick={() => void prepare()}>
            {card ? 'Darle otra ficha' : 'Darle su ficha'}
          </Button>
        )}
        {card ? (
          <Button variant="ghost" size="sm" loading={busy} onClick={() => void revoke()}>
            Anular ficha
          </Button>
        ) : null}
      </div>
      {code && !writing ? <span style={mute}>Acerca la ficha en blanco y pulsa «Grabar».</span> : null}
      {!canWrite ? <span style={mute}>{NO_WEB_NFC}</span> : null}
      {note ? <Notice tone="success">{note}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {dialog}
    </section>
  );
}

const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 0' };
const row: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.125rem' };
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' };
const mute: CSSProperties = { color: 'var(--np-text-mute)', fontSize: 'var(--np-fs-14)' };
