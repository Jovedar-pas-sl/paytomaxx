'use client';

import type { CSSProperties } from 'react';
import type { MoneyMap } from '@nightpay/contracts';
import { barSegments, eurShort, legendFlex, moneyMapView, type Segment } from '@/lib/money-map-view';
import { moneyMapDetails, type MoneyDetail } from '@/lib/money-map-details';
import { useSections } from '@/lib/use-sections';

/**
 * El mapa del dinero (maqueta 8 · A, barras apiladas), en el orden del
 * dinero: cifras de la noche, cómo entra, por sección, dónde está y qué
 * sale. `wide`: en el escritorio, los carriles en dos columnas.
 */
export function MoneyMapView({ map, wide = false }: { map: MoneyMap; wide?: boolean }) {
  const { sections } = useSections();
  const v = moneyMapView(map, sections);
  const details = moneyMapDetails(map);
  const inflowTotal = v.inflow.reduce((a, s) => a + Math.max(0, s.cents), 0);
  return (
    <div className="np-mm-body" data-layout={wide ? 'wide' : undefined}>
      <div className="np-mm-kpis">
        <div className="np-mm-grow">
          <span className="np-mm-lbl">{v.salesLabel}</span>
          <span className="np-mm-num np-mm-big">{eurShort(v.salesCents)}</span>
        </div>
        <Ring pct={v.venuePct} />
        <div className="np-mm-side">
          <span className="np-mm-lbl">Para el local</span>
          <b className="np-mm-num">{eurShort(v.venueCents)}</b>
        </div>
      </div>

      <div className="np-mm-col">
        <section className="np-mm-block" aria-label="Cómo entra">
          <div className="np-mm-blockhead">
            <h3 className="np-mm-kick">Cómo entra</h3>
          </div>
          <Bar segments={v.inflow} label="Cómo entra el dinero" />
          {v.inflow.length === 0 ? <p className="np-mm-note">Aún no hay ventas.</p> : null}
          <ul className="np-mm-hleg">
            {v.inflow.map((s) => (
              <li key={s.key} style={{ flex: legendFlex(Math.max(0, s.cents), inflowTotal) }}>
                {s.label}
                <b>{eurShort(s.cents)}</b>
              </li>
            ))}
          </ul>
          <Detail detail={details.inflow} />
          {v.topUps ? (
            <p className="np-mm-hold">
              + Recargas <b>{eurShort(v.topUps.cents)}</b>: {v.topUps.detail ? <span>{v.topUps.detail} · </span> : null}no es venta
            </p>
          ) : null}
          <Detail detail={details.topUps} />
        </section>

        <section className="np-mm-block" aria-label="Por sección">
          <div className="np-mm-blockhead">
            <h3 className="np-mm-kick">Por sección</h3>
          </div>
          <ul className="np-mm-srows">
            {v.sections.map((s) => (
              <li key={s.key} className="np-mm-sr" style={{ '--np-c': s.color } as CSSProperties}>
                <span>{s.label}</span>
                <span className="np-mm-track" aria-hidden="true">
                  <i data-zero={s.cents <= 0 || undefined} style={{ '--p': `${s.pct}%` } as CSSProperties} />
                </span>
                <b>{eurShort(s.cents)}</b>
              </li>
            ))}
          </ul>
          <details className="np-mm-detail">
            <summary>Cobros por sección</summary>
            <ul className="np-mm-orows">
              {v.sections.map((s) => <li key={s.key} className="np-mm-orow"><span>{s.label}</span><b>{map.sections.find((r) => r.code === s.key)?.count ?? 0} cobros</b></li>)}
            </ul>
            <p className="np-mm-note">Un cobro con varias secciones cuenta en cada una; no sumes estos recuentos como cobros únicos.</p>
          </details>
        </section>
        <section className="np-mm-block" aria-label="Cómo se reparte">
          <h3 className="np-mm-kick">Cómo se reparte</h3>
          <Bar segments={[
            { key: 'venue', label: 'Local', cents: map.split.venueCents, color: 'var(--np-mm-tuyo)' },
            { key: 'staff', label: 'Personal', cents: map.split.chicasCents + map.split.camarerosCents, color: 'var(--np-mm-personal)' },
            { key: 'fees', label: 'Comisiones', cents: map.split.commissions.totalCents, color: 'var(--np-mm-saldo)' },
          ]} label="Reparto de las ventas" />
          <Detail detail={details.split} />
        </section>
      </div>

      <div className="np-mm-col">
        <section className="np-mm-block" aria-label="Dónde está">
          <div className="np-mm-blockhead">
            <h3 className="np-mm-kick">Dónde está</h3>
            <b>{eurShort(v.where.totalCents)}</b>
          </div>
          <Bar segments={v.where.places} label="Dónde está el dinero" />
          <Legend segments={v.where.places} />
          <Bar segments={v.where.owners} label="De quién es" style={{ marginTop: '0.25rem' }} />
          <Legend segments={v.where.owners} />
          {v.where.note ? <p className="np-mm-note">{v.where.note}</p> : null}
          <Detail detail={details.cash} />
          <Detail detail={details.owed} />
        </section>

        <section className="np-mm-block" aria-label="Qué sale">
          <div className="np-mm-blockhead">
            <h3 className="np-mm-kick">Qué sale</h3>
          </div>
          <ul className="np-mm-orows">
            {v.outflow.map((r) => (
              <li key={r.key} className="np-mm-orow">
                <span>
                  {r.label} <em>· {r.note}</em>
                </span>
                <b>{eurShort(r.cents)}</b>
              </li>
            ))}
          </ul>
          <Detail detail={details.outflow} />
        </section>
      </div>
    </div>
  );
}

/** Barra apilada: un trozo por cosa con importe (los grises o el color de la sección). */
function Bar({ segments, label, style }: { segments: Segment[]; label: string; style?: CSSProperties }) {
  const shown = barSegments(segments);
  const text = segments.map((s) => `${s.label} ${eurShort(s.cents)}`).join(', ');
  return (
    <div className="np-mm-hbar" role="img" aria-label={`${label}: ${text}`} style={style}>
      {shown.map((s) => (
        <i key={s.key} style={{ '--np-c': s.color, flex: s.cents } as CSSProperties} />
      ))}
    </div>
  );
}

function Legend({ segments }: { segments: Segment[] }) {
  return (
    <ul className="np-mm-dleg">
      {segments.map((s) => (
        <li key={s.key} style={{ '--np-c': s.color } as CSSProperties}>
          {s.label} <b data-neg={s.cents < 0 || undefined}>{eurShort(s.cents)}</b>
        </li>
      ))}
    </ul>
  );
}

/** Anillo con el % que se queda el local. */
function Ring({ pct }: { pct: number }) {
  return (
    <span className="np-mm-ring" role="img" aria-label={`El local se queda el ${pct} %`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="np-mm-rb" cx="18" cy="18" r="15" fill="none" strokeWidth="4" />
        <circle
          className="np-mm-rf"
          cx="18"
          cy="18"
          r="15"
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${pct} 100`}
        />
      </svg>
      <span aria-hidden="true">{pct}%</span>
    </span>
  );
}

/** Disclosure nativo: teclado, lector de pantalla y estado conservado al refrescar los datos. */
function Detail({ detail }: { detail: MoneyDetail }) {
  return (
    <details className="np-mm-detail">
      <summary>{detail.title}</summary>
      <ul className="np-mm-orows">
        {detail.rows.map((r, index) => (
          <li key={`${r.label}-${index}`} className="np-mm-orow">
            <span>{r.label}{r.count !== undefined ? <em> · {r.count} operaciones</em> : null}</span>
            <b data-neg={r.cents !== null && r.cents < 0 || undefined}>{r.cents === null ? 'No disponible' : eurShort(r.cents)}</b>
          </li>
        ))}
      </ul>
      <p className="np-mm-note">{detail.note}</p>
    </details>
  );
}
