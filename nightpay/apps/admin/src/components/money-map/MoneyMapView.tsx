'use client';

import type { CSSProperties } from 'react';
import type { MoneyMap } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';
import { eurShort } from '@/lib/money-map-view';
import { moneyMapDetails, type MoneyDetail } from '@/lib/money-map-details';
import { canOpenSection, type MoneyMapTarget } from '@/lib/money-map-cobros';
import { moneyMapQuestions, type QuestionCard } from '@/lib/money-map-questions';
import { useSections } from '@/lib/use-sections';
import { Skel } from '../Skeleton';

interface Props {
  map: MoneyMap;
  /** Las ventas y cada sección abren los cobros que explican esa cifra. */
  onOpen?: (target: MoneyMapTarget) => void;
  /** «Cerrar la caja» (Noches) y «Ver por compañera» (Pagos a compañeras). */
  onAction?: (action: NonNullable<QuestionCard['action']>) => void;
}

const ACTION_LABELS: Record<NonNullable<QuestionCard['action']>, string> = {
  'close-cash': 'Cerrar la caja',
  'by-person': 'Ver por compañera',
};

/** La marca de cada tarjeta para el tutorial (lib/tours.ts). */
const TOUR: Record<QuestionCard['key'], { 'data-tour': string }> = {
  ganado: { 'data-tour': 'mapa-ganado' },
  caja: { 'data-tour': 'mapa-caja' },
  banco: { 'data-tour': 'mapa-banco' },
  debo: { 'data-tour': 'mapa-debo' },
};

/**
 * El mapa del dinero en cuatro preguntas (Grafito 3, opción B): cuánto he
 * ganado, cuánto tiene que haber en la caja, cuánto llega al banco y cuánto
 * debo a las compañeras. Debajo, el saldo de clientes sin gastar y lo vendido
 * por sección; el detalle de las cuentas, plegado. Qué campo va en cada
 * tarjeta: lib/money-map-questions.ts.
 */
export function MoneyMapView({ map, onOpen, onAction }: Props) {
  const { sections } = useSections();
  const q = moneyMapQuestions(map, sections);
  const details = moneyMapDetails(map);
  const blocks = [details.inflow, details.topUps, ...(details.serviceFee ? [details.serviceFee] : []), details.split, details.cash, details.owed, details.outflow];
  return (
    <div className="np-mmq">
      <div className="np-mmq-cards">
        {q.cards.map((card) => (
          <QuestionCardView key={card.key} card={card} onAction={onAction} />
        ))}
      </div>

      <p className="np-mmq-saldo" data-known={q.savedBalance.cents !== null || undefined}>
        <span className="np-mmq-dot" aria-hidden="true" />
        <span>{q.savedBalance.text}</span>
      </p>

      <section className="np-mmq-sold" aria-label={q.sold.label} data-tour="mapa-vendido">
        {onOpen ? (
          <button type="button" className="np-mmq-sold-total np-mm-open" onClick={() => onOpen({ kind: 'sales' })} aria-label={`Ver los cobros de ${q.sold.label.toLowerCase()}`}>
            <span>Lo vendido</span>
            <b className="np-mmq-sold-num">{eurShort(q.sold.cents)}</b>
          </button>
        ) : (
          <div className="np-mmq-sold-total">
            <span>Lo vendido</span>
            <b className="np-mmq-sold-num">{eurShort(q.sold.cents)}</b>
          </div>
        )}
        {q.sold.parts.length === 0 ? (
          <p className="np-mmq-none">Aún no hay ventas.</p>
        ) : (
          <ul className="np-mmq-parts">
            {q.sold.parts.map((s) => {
              const content = (
                <>
                  <span className="np-mmq-swatch" aria-hidden="true" />
                  <span>{s.label}</span>
                  <b>{eurShort(s.cents)}</b>
                </>
              );
              return (
                <li key={s.key} style={{ '--np-c': s.color } as CSSProperties}>
                  {onOpen && canOpenSection(s.key) ? (
                    <button type="button" className="np-mmq-part np-mm-open" onClick={() => onOpen({ kind: 'section', code: s.key })} aria-label={`Ver los cobros de ${s.label}: ${eurShort(s.cents)}`}>
                      {content}
                    </button>
                  ) : (
                    <span className="np-mmq-part">{content}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <details className="np-mm-detail np-mmq-more">
        <summary>Ver el detalle de las cuentas</summary>
        <div className="np-mmq-blocks">
          {blocks.map((b) => (
            <DetailBlock key={b.title} detail={b} />
          ))}
        </div>
      </details>
    </div>
  );
}

/** Las cuatro tarjetas y la fila de lo vendido en silueta, mientras llega el mapa. */
export function MoneyMapSkeleton() {
  return (
    <div className="np-mmq" role="status" aria-busy="true">
      <span className="np-sr-only">Cargando el mapa del dinero…</span>
      <div className="np-mmq-cards" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="np-mmq-card">
            <Skel width="70%" height="1.125rem" />
            <Skel width="45%" height="2.75rem" />
            <Skel width="90%" height="0.875rem" />
          </div>
        ))}
      </div>
      <div className="np-mmq-saldo" aria-hidden="true" style={{ borderColor: 'var(--np-border)', background: 'transparent' }}>
        <Skel width="60%" height="1rem" />
      </div>
      <div className="np-mmq-sold" aria-hidden="true">
        <Skel width="12rem" height="1.25rem" />
        <Skel width="16rem" height="1rem" />
      </div>
    </div>
  );
}

function QuestionCardView({ card, onAction }: { card: QuestionCard; onAction?: Props['onAction'] }) {
  const action = card.action;
  return (
    <section className="np-mmq-card" data-tone={card.key} {...TOUR[card.key]}>
      <h3 className="np-mmq-q">{card.question}</h3>
      <div className="np-mmq-row">
        <span className="np-mmq-num">{eurShort(card.cents)}</span>
        {action && onAction ? (
          <Button variant="ghost" size="sm" onClick={() => onAction(action)}>
            {ACTION_LABELS[action]}
          </Button>
        ) : null}
      </div>
      <p className="np-mmq-cap">{card.caption}</p>
    </section>
  );
}

function DetailBlock({ detail }: { detail: MoneyDetail }) {
  return (
    <section className="np-mmq-block">
      <h4>{detail.title}</h4>
      <ul className="np-mm-orows">
        {detail.rows.map((r, index) => (
          <li key={`${r.label}-${index}`} className="np-mm-orow">
            <span>
              {r.label}
              {r.count !== undefined ? <em> · {r.count} operaciones</em> : null}
            </span>
            <b data-neg={(r.cents !== null && r.cents < 0) || undefined}>{r.cents === null ? 'No disponible' : eurShort(r.cents)}</b>
          </li>
        ))}
      </ul>
      <p className="np-mm-note">{detail.note}</p>
    </section>
  );
}
