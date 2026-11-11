'use client';

import { useState, type CSSProperties } from 'react';
import { OXIOPAY_SETTLEMENTS_LABEL, type SettlementListItem } from '@nightpay/contracts';
import { downloadOwnerSettlement, fetchOwnerSettlement, fetchOwnerSettlements } from '@/lib/endpoints/oxiopay-settlements';
import { formatEur } from '@/lib/money';
import { settlementPeriodText, settlementStatusView } from '@/lib/oxiopay-settlements';
import '../styles/panel-superadmin.css';
import '../styles/panel-liquidacion.css';
import { Pill } from './Pill';
import { SettlementView } from './settlements/SettlementView';
import { BackButton, LoadGate } from './superadmin/ui';
import { useLoad } from './superadmin/use-load';

/**
 * «Liquidaciones OxioPay» del dueño (Informes): lo que su local debe a OxioPay
 * cada semana, solo lectura. La lista con su estado y lo pendiente; la ficha
 * con el desglose, los datos de la transferencia, el documento para imprimir /
 * guardar en PDF y el CSV. Los pagos los apunta OxioPay al recibirlos.
 */
export function OxioPaySettlementsPanel() {
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useLoad((signal) => fetchOwnerSettlements(signal), []);

  if (openId) {
    return <OwnerSettlementDetail id={openId} onBack={() => setOpenId(null)} />;
  }

  return (
    <section style={wrap} aria-labelledby="liq-owner-title">
      <div>
        <p className="np-liq-kicker">Informes</p>
        <h2 id="liq-owner-title" style={title}>
          {OXIOPAY_SETTLEMENTS_LABEL}
        </h2>
        <p style={hint}>
          Lo que el local debe a OxioPay cada semana (de lunes 08:00 a lunes 08:00): la comisión del servicio que pagan los clientes y la
          comisión de plataforma donde no la hay. Se emite el lunes por la mañana; se paga por transferencia con su referencia.
        </p>
      </div>
      <LoadGate loaded={list} what="las liquidaciones">
        {(page) => (
          <>
            {page.pendingCents > 0 ? (
              <p style={pendingLine}>
                Pendiente de pagar: <strong className="np-liq-num">{formatEur(page.pendingCents)}</strong>
              </p>
            ) : null}
            {page.items.length === 0 ? (
              <p style={hint}>Aún no hay ninguna liquidación: la primera sale el lunes después de una semana con algo que liquidar.</p>
            ) : (
              <ul className="np-liq-list">
                {page.items.map((item) => (
                  <li key={item.id}>
                    <SettlementRow item={item} onOpen={() => setOpenId(item.id)} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </LoadGate>
    </section>
  );
}

export function SettlementRow({ item, onOpen, showVenue }: { item: SettlementListItem; onOpen: () => void; showVenue?: boolean }) {
  const status = settlementStatusView(item);
  return (
    <button type="button" className="np-liq-item" data-overdue={item.overdue ? 'true' : undefined} onClick={onOpen}>
      <span>
        <span className="np-liq-item-ref">{item.reference}</span>
        <span className="np-liq-item-meta">
          {showVenue ? `${item.venue.name} · ` : ''}
          {settlementPeriodText(item)}
        </span>
      </span>
      <span className="np-liq-item-amount">
        {formatEur(item.status === 'VOID' ? item.totalCents : item.pendingCents > 0 ? item.pendingCents : item.totalCents)}
        <Pill tone={status.tone}>{status.label}</Pill>
      </span>
    </button>
  );
}

function OwnerSettlementDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useLoad((signal) => fetchOwnerSettlement(id, signal), [id]);
  return (
    <div style={wrap}>
      <BackButton onClick={onBack}>Todas las liquidaciones</BackButton>
      <LoadGate loaded={detail} what="la liquidación">
        {(d) => <SettlementView detail={d} audience="owner" download={(kind) => downloadOwnerSettlement(d.id, kind)} />}
      </LoadGate>
    </div>
  );
}

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1.25rem', minWidth: 0 };
const title: CSSProperties = { margin: '0.25rem 0 0', fontSize: 'var(--np-t-h3)', fontWeight: 600 };
const hint: CSSProperties = { margin: '0.35rem 0 0', color: 'var(--np-text-mute)', fontSize: '1rem', maxWidth: '46rem' };
const pendingLine: CSSProperties = { margin: 0, fontSize: '1rem' };
