'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { MoneyMap } from '@nightpay/contracts';
import { barSegments, eurShort, legendFlex, moneyMapView, type Segment } from '@/lib/money-map-view';
import { moneyMapDetails, type MoneyDetail } from '@/lib/money-map-details';
import { canOpenSection, type MoneyMapTarget } from '@/lib/money-map-cobros';
import { useSections } from '@/lib/use-sections';

/**
 * El mapa del dinero (maqueta 8 · A, barras apiladas), en el orden del
 * dinero: cifras de la noche, cómo entra, por sección, cómo se reparte,
 * dónde está y qué sale. `wide`: en el escritorio, los carriles en dos
 * columnas. `onOpen`: las ventas, cada sección y «Del saldo» abren los cobros
 * que explican esa cifra.
 */
export function MoneyMapView({ map, wide = false, onOpen }: { map: MoneyMap; wide?: boolean; onOpen?: (target: MoneyMapTarget) => void }) {
  const { sections } = useSections();
  const v = moneyMapView(map, sections);
  const details = moneyMapDetails(map);
  const inflowTotal = v.inflow.reduce((a, s) => a + Math.max(0, s.cents), 0);
  return (
    <div className="np-mm-body" data-layout={wide ? 'wide' : undefined}>
      {/* Arriba, las cifras que importan; en el escritorio, cuatro en fila (decisión D8). */}
      <div className="np-mm-kpis">
        <Opens target={{ kind: 'sales' }} onOpen={onOpen} label={`Ver los cobros de ${v.salesLabel.toLowerCase()}`} className="np-mm-grow">
          <span className="np-mm-lbl">{v.salesLabel}</span>
          <span className="np-mm-num np-mm-big">{eurShort(v.salesCents)}</span>
          <small className="np-mm-cap">sin recargas</small>
        </Opens>
        <Ring pct={v.venuePct} />
        <div className="np-mm-side">
          <span className="np-mm-lbl">Para el local</span>
          <b className="np-mm-num">{eurShort(v.venueCents)}</b>
          <small className="np-mm-cap">{v.venuePct} % de las ventas</small>
        </div>
        {wide ? (
          <>
            <div className="np-mm-side np-mm-more">
              <span className="np-mm-lbl">Propinas</span>
              <b className="np-mm-num">{eurShort(v.tipsCents)}</b>
              <small className="np-mm-cap">para el personal</small>
            </div>
            <div className="np-mm-side np-mm-more">
              <span className="np-mm-lbl">Cobros</span>
              <b className="np-mm-num">{v.salesCount}</b>
              <small className="np-mm-cap">con tarjeta y del saldo</small>
            </div>
          </>
        ) : null}
      </div>
      {onOpen ? <p className="np-mm-note np-mm-hint">Toca las ventas, una sección o «Del saldo» para ver sus cobros.</p> : null}

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
                {s.key === 'saldo' && onOpen ? (
                  <button type="button" className="np-mm-open" onClick={() => onOpen({ kind: 'saldo' })} aria-label={`Ver los cobros del saldo: ${eurShort(s.cents)}`}>
                    {s.label}
                    <b>{eurShort(s.cents)}</b>
                  </button>
                ) : (
                  <>
                    {s.label}
                    <b>{eurShort(s.cents)}</b>
                  </>
                )}
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
          {v.serviceFee ? (
            <p className="np-mm-hold">
              + Comisión del servicio <b>{eurShort(v.serviceFee.cents)}</b>:{' '}
              {v.serviceFee.detail ? <span>{v.serviceFee.detail} · </span> : null}se debe a OxioPay
            </p>
          ) : null}
          {details.serviceFee ? <Detail detail={details.serviceFee} /> : null}
        </section>

        <section className="np-mm-block" aria-label="Por sección">
          <div className="np-mm-blockhead">
            <h3 className="np-mm-kick">Por sección</h3>
          </div>
          <ul className="np-mm-srows">
            {v.sections.map((s) => {
              const row = (
                <>
                  <span>{s.label}</span>
                  <span className="np-mm-track" aria-hidden="true">
                    <i data-zero={s.cents <= 0 || undefined} style={{ '--p': `${s.pct}%` } as CSSProperties} />
                  </span>
                  <b>{eurShort(s.cents)}</b>
                </>
              );
              const open = onOpen && canOpenSection(s.key);
              return (
                <li key={s.key} style={{ '--np-c': s.color } as CSSProperties}>
                  {open ? (
                    <button type="button" className="np-mm-sr" data-open onClick={() => onOpen({ kind: 'section', code: s.key })} aria-label={`Ver los cobros de ${s.label}: ${eurShort(s.cents)}`}>
                      {row}
                      <Chevron />
                    </button>
                  ) : (
                    <div className="np-mm-sr" data-open={onOpen ? 'no' : undefined}>{row}</div>
                  )}
                </li>
              );
            })}
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
          <div className="np-mm-blockhead">
            <h3 className="np-mm-kick">Cómo se reparte</h3>
            <b>{eurShort(map.salesCents)}</b>
          </div>
          <Bar segments={v.split} label="Reparto de las ventas" />
          <Legend segments={v.split} />
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
          <p className="np-mm-note">
            «Saldo nuevo de clientes (estas fechas)» es lo que estas fechas sumaron o restaron al saldo de los
            clientes (recargas − consumos − saldo devuelto); puede ser negativo. No es el saldo real de los clientes:
          </p>
          <div className="np-mm-balance">
            <span>{v.where.balance.label}</span>
            <b className="np-mm-num">{v.where.balance.cents === null ? 'No disponible' : eurShort(v.where.balance.cents)}</b>
          </div>
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

/** Una cifra que, si el mapa deja, abre sus cobros. */
function Opens({ target, onOpen, label, className, children }: {
  target: MoneyMapTarget;
  onOpen?: (target: MoneyMapTarget) => void;
  label: string;
  className: string;
  children: ReactNode;
}) {
  if (!onOpen) return <div className={className}>{children}</div>;
  return (
    <button type="button" className={`${className} np-mm-open`} onClick={() => onOpen(target)} aria-label={label}>
      {children}
    </button>
  );
}

function Chevron() {
  return (
    <svg className="np-mm-chev" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5l7 7-7 7" />
    </svg>
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
