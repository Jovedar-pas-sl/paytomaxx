'use client';

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { CobroDetail, CobroRow } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';
import { fetchCobroDetail } from '@/lib/api';
import {
  amountRows,
  bankRows,
  cardMoreText,
  detailStatus,
  deviceRow,
  flagTexts,
  lineLabel,
  methodText,
  shareTextOf,
  splitRows,
  undoText,
  whereText,
  type DetailRow,
} from '@/lib/cobro-detail-view';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { useSections } from '@/lib/use-sections';
import { useVenueTimezone } from '@/lib/venue-context';
import { Pill } from '../Pill';
import { StepUpDialog } from '../StepUpDialog';
import { PaymentReferenceDetails } from './PaymentReferenceDetails';

/**
 * «Ver detalle» de un cobro (encargado y dueño): qué, cuándo, dónde, quién
 * cobró y cómo se pagó; lo pagado (propina y comisión del servicio aparte);
 * si se devolvió o se canceló, quién, cuándo y por qué; las señales, el
 * reparto (el dueño, y el encargado con «Informes») y lo del banco. Lo
 * delicado (el móvil y la IP, la tarjeta más allá de los 4 últimos y el
 * historial) con «Verificar» (5 minutos). «Compartir» manda un texto corto
 * con el enlace al cobro en el panel (pide iniciar sesión): nunca el móvil, la
 * IP ni el historial. Debajo, los datos del banco para copiarlos.
 */
export function CobroDetailPanel({ row }: { row: CobroRow }) {
  const tz = useVenueTimezone();
  const { sections } = useSections();
  const [detail, setDetail] = useState<CobroDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [shared, setShared] = useState<string | null>(null);
  const when = (iso: string) => formatDateTime(iso, tz);

  const load = useCallback(() => {
    fetchCobroDetail(row.kind, row.id).then(
      (d) => {
        setDetail(d);
        setError(null);
      },
      (err: Error) => setError(err.message),
    );
  }, [row.kind, row.id]);
  useEffect(load, [load]);

  async function share(d: CobroDetail): Promise<void> {
    const text = shareTextOf(d, formatEur, when);
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: d.ref ? `Cobro ${d.ref}` : 'Cobro', text });
        return;
      }
      await navigator.clipboard.writeText(text);
      setShared('Copiado. Pégalo donde quieras.');
    } catch (err) {
      // Cerrar el menú de compartir no es un error.
      if ((err as { name?: string }).name !== 'AbortError') setShared('No se pudo compartir.');
    }
  }

  if (error) return <p role="alert" style={{ color: 'var(--np-danger)' }}>{error}</p>;
  if (!detail) return <p>Cargando el detalle…</p>;
  const status = detailStatus(detail);
  const flags = flagTexts(detail);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
        <b className="np-num" style={{ fontSize: '1.75rem', fontWeight: 600 }}>{formatEur(detail.totalCents)}</b>
        <Pill tone={status.tone}>{status.label}</Pill>
        <span style={mute}>{[detail.ref, detail.confirmationCode ? `código ${detail.confirmationCode}` : null].filter(Boolean).join(' · ')}</span>
      </div>
      {flags.length > 0 ? (
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
          {flags.map((f) => (
            <Pill key={f} tone="warning">{f}</Pill>
          ))}
        </div>
      ) : null}

      <Block title="Qué">
        {detail.lines.length > 0 ? (
          detail.lines.map((l, i) => (
            <Row key={i} label={lineLabel(l)} value={formatEur(l.amountCents)} />
          ))
        ) : (
          // Sin líneas (un cobro antiguo o una recarga): qué fue; el importe va justo debajo.
          <p style={{ margin: 0 }}>{detail.service ?? (detail.isTopUp ? 'Recarga de saldo' : 'Cobro')}</p>
        )}
        {amountRows(detail, formatEur).map((r) => (
          <Row key={r.label} {...r} strong={r.label === 'Total'} />
        ))}
      </Block>

      <Block title="Cuándo, dónde y cómo">
        <Row label="Creado" value={when(detail.createdAt)} />
        {detail.paidAt ? <Row label="Pagado" value={when(detail.paidAt)} /> : null}
        <Row label="Dónde" value={whereText(detail, sections)} />
        <Row label="Quién cobró" value={detail.chargedBy?.name ?? 'Nadie del local (el cliente solo)'} />
        <Row label="Cómo se pagó" value={methodText(detail)} />
      </Block>

      {detail.undo.length > 0 ? (
        <Block title="Devuelto o cancelado">
          {detail.undo.map((u, i) => (
            <p key={i} style={{ margin: 0 }}>{undoText(u, formatEur, when)}</p>
          ))}
        </Block>
      ) : null}

      {detail.split ? <Block title="Reparto">{splitRows(detail.split, formatEur).map((r) => <Row key={r.label} {...r} />)}</Block> : null}

      {detail.bank ? (
        <Block title="Banco">
          {bankRows(detail.bank).map((r) => (
            <Row key={r.label} {...r} />
          ))}
        </Block>
      ) : null}

      <Block title="Lo delicado">
        {detail.sensitive ? (
          <>
            {detail.sensitive.devices.length === 0 ? <p style={mute}>Sin dispositivos apuntados.</p> : null}
            {detail.sensitive.devices.map((d, i) => {
              const r = deviceRow(d);
              return <Row key={i} label={`${r.who} · ${r.step}`} value={`${r.device} · ${r.ip}`} />;
            })}
            {detail.sensitive.card ? (
              <Row label="La tarjeta" value={cardMoreText(detail.sensitive.card)} />
            ) : null}
            {detail.sensitive.history.map((h, i) => (
              <Row key={`h${i}`} label={when(h.at)} value={[h.what, h.detail].filter(Boolean).join(' · ')} />
            ))}
          </>
        ) : (
          <>
            <p style={mute}>El móvil y la IP, la tarjeta más allá de los 4 últimos y el historial piden verificarte (vale 5 minutos).</p>
            <div>
              <Button variant="ghost" size="sm" onClick={() => setVerifying(true)}>
                Verificar
              </Button>
            </div>
          </>
        )}
      </Block>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Button variant="ghost" size="sm" onClick={() => void share(detail)}>
          Compartir
        </Button>
        {shared ? <span role="status" style={mute}>{shared}</span> : null}
      </div>

      <PaymentReferenceDetails row={row} />

      <StepUpDialog
        open={verifying}
        onClose={() => setVerifying(false)}
        onVerified={load}
        reason="Para ver el móvil y la IP, la tarjeta y el historial de este cobro."
      />
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <h3 style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 600, color: 'var(--np-text-mute)' }}>{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value, strong }: DetailRow & { strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontWeight: strong ? 600 : 400 }}>
      <span>{label}</span>
      <span className="np-num" style={{ textAlign: 'right', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

const mute: CSSProperties = { margin: 0, fontSize: '0.875rem', color: 'var(--np-text-mute)' };
