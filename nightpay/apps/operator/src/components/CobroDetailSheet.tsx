'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  cobroShareText,
  detailAmountTexts,
  detailFlagTexts,
  detailLineLabel,
  detailMethodText,
  detailMineTexts,
  detailUndoText,
  type CobroDetail,
  type CobroKind,
} from '@nightpay/contracts';
import { Button, Modal, receiptFromDetail, usePrintTicket } from '@nightpay/ui';
import { paymentTimeLabel } from '@/lib/earnings-view';
import { formatEur } from '@/lib/money';
import { fetchOwnCobroDetail, ownDetailStatus, ownDeviceText, ownWhereText } from '@/lib/own-cobro-detail';
import { StepUpSheet } from './StepUpSheet';
import styles from './cobro-detail.module.css';

const eur = (cents: number) => formatEur(cents);
const when = (iso: string) => paymentTimeLabel(new Date(iso));

/**
 * El detalle de uno de sus cobros: qué, cuándo, quién cobró y cómo se pagó;
 * lo pagado (propina y comisión del servicio aparte); si se devolvió o se
 * canceló; y «Lo tuyo» (su comisión, su propina, su parte de la invitación).
 * Nunca la parte del local. «Ver más» (verificándose, 5 minutos): su móvil en
 * cada paso y el historial. «Compartir»: un texto corto con el enlace al
 * cobro en el panel, sin el móvil, la IP ni el historial.
 */
export function CobroDetailSheet({ target, onClose }: { target: { kind: CobroKind; id: string } | null; onClose: () => void }) {
  const [detail, setDetail] = useState<CobroDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [shared, setShared] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!target) return undefined;
    const ctrl = new AbortController();
    fetchOwnCobroDetail(target.kind, target.id, ctrl.signal).then(
      (d) => {
        setDetail(d);
        setError(null);
      },
      (err: Error) => {
        if (!ctrl.signal.aborted) setError(err.message);
      },
    );
    return () => ctrl.abort();
  }, [target]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setShared(null);
    return load();
  }, [load]);

  async function share(d: CobroDetail): Promise<void> {
    const text = cobroShareText(d, { eur, when });
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: d.ref ? `Cobro ${d.ref}` : 'Cobro', text });
        return;
      }
      await navigator.clipboard.writeText(text);
      setShared('Copiado. Pégalo donde quieras.');
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') setShared('No se pudo compartir.');
    }
  }

  return (
    <Modal open={Boolean(target)} onClose={onClose} title={detail?.ref ? `Cobro ${detail.ref}` : 'Detalle del cobro'}>
      {error ? (
        <p role="alert" className={styles.mute} style={{ color: 'var(--np-danger)' }}>
          {error}
        </p>
      ) : null}
      {!detail && !error ? <p className={styles.mute}>Cargando el cobro…</p> : null}
      {detail ? <DetailBody d={detail} onShare={() => void share(detail)} shared={shared} onMore={() => setVerifying(true)} /> : null}
      <StepUpSheet open={verifying} onClose={() => setVerifying(false)} onVerified={() => load()} />
    </Modal>
  );
}

function DetailBody({ d, onShare, shared, onMore }: { d: CobroDetail; onShare: () => void; shared: string | null; onMore: () => void }) {
  // El ticket del cliente (solo de lo pagado): lo comprado, el total y cómo se pagó; nunca «lo tuyo».
  const printer = usePrintTicket();
  return (
    <div className={styles.sheet}>
      <div className={styles.head}>
        <b className={`np-num ${styles.total}`}>{eur(d.totalCents)}</b>
        <span className={styles.status}>{ownDetailStatus(d.status)}</span>
        {d.confirmationCode ? <span className={styles.mute}>código {d.confirmationCode}</span> : null}
      </div>
      {detailFlagTexts(d).map((f) => (
        <p key={f} className={styles.flag}>
          {f}
        </p>
      ))}

      <Block title="Qué">
        {d.lines.length > 0
          ? d.lines.map((l, i) => <Line key={i} label={detailLineLabel(l)} value={eur(l.amountCents)} />)
          : null}
        {detailAmountTexts(d, eur).map((r) => (
          <Line key={r.label} {...r} strong={r.label === 'Total'} />
        ))}
      </Block>

      <Block title="Cuándo y cómo">
        <Line label="Creado" value={when(d.createdAt)} />
        {d.paidAt ? <Line label="Pagado" value={when(d.paidAt)} /> : null}
        <Line label="Dónde" value={ownWhereText(d)} />
        <Line label="Quién cobró" value={d.chargedBy?.name ?? 'El cliente, desde su móvil'} />
        <Line label="Cómo se pagó" value={detailMethodText(d)} />
      </Block>

      {d.undo.length > 0 ? (
        <Block title="Devuelto o cancelado">
          {d.undo.map((u, i) => (
            <p key={i} className={styles.mute} style={{ color: 'var(--np-text)' }}>
              {detailUndoText(u, eur, when)}
            </p>
          ))}
        </Block>
      ) : null}

      {d.mine ? (
        <Block title="Lo tuyo">
          {detailMineTexts(d.mine, eur).map((r) => (
            <Line key={r.label} {...r} strong={r.label === 'Para ti'} />
          ))}
        </Block>
      ) : null}

      {d.sensitive ? (
        <Block title="Más">
          {d.sensitive.devices.map((dev, i) => {
            const t = ownDeviceText(dev);
            return <Line key={i} label={`Tu móvil · ${t.step}`} value={t.text} />;
          })}
          {d.sensitive.history.map((h, i) => (
            <Line key={`h${i}`} label={when(h.at)} value={[h.what, h.detail].filter(Boolean).join(' · ')} />
          ))}
        </Block>
      ) : null}

      <div className={styles.buttons}>
        {d.paidAt ? (
          <Button variant="ghost" onClick={() => printer.print(receiptFromDetail(d))}>
            Imprimir ticket
          </Button>
        ) : null}
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onShare}>
            Compartir
          </Button>
          {d.sensitive ? null : (
            <Button variant="ghost" onClick={onMore}>
              Ver más
            </Button>
          )}
        </div>
      </div>
      {printer.error ? (
        <p role="alert" className={styles.mute} style={{ color: 'var(--np-danger)' }}>
          {printer.error}
        </p>
      ) : null}
      {printer.ticketNode}
      {shared ? (
        <p role="status" className={styles.mute}>
          {shared}
        </p>
      ) : null}
      {d.sensitive ? null : <p className={styles.mute}>«Ver más» enseña tu móvil en cada paso y el historial del cobro: pide verificarte (vale 5 minutos).</p>}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.block}>
      <h3 className={styles.blockTitle}>{title}</h3>
      {children}
    </section>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={styles.line} data-strong={strong || undefined}>
      <span>{label}</span>
      <span className="np-num">{value}</span>
    </div>
  );
}
