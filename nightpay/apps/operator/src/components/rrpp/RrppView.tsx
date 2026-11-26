'use client';

import { useEffect, useState } from 'react';
import { Button, EmptyState } from '@nightpay/ui';
import type { MyPromoterReservation, MyPromoterView } from '@nightpay/contracts';
import { formatBps, formatEur } from '@/lib/money';
import { commissionText, nightLabel, RRPP_PATH, statusTone, upcomingText } from '@/lib/rrpp';
import { CobroQr } from '../cobrar/CobroQr';
import { Chevron } from '../TonightCard';
import styles from './rrpp.module.css';

/**
 * «Tus reservas de RRPP»: su enlace (con su QR para enseñarlo), su comisión y
 * sus reservas. De cada reserva solo lo del paquete: nunca el nombre, el
 * teléfono ni las notas del cliente.
 */
export function RrppView({ view }: { view: MyPromoterView }) {
  return (
    <>
      <LinkSection url={view.url} />
      <section className={styles.section} aria-labelledby="rrpp-comision">
        <h2 id="rrpp-comision" className={styles.h2}>
          Tu comisión <span className={styles.h2Note}>· {formatBps(view.commissionBps)} del paquete</span>
        </h2>
        <dl className={styles.money}>
          <MoneyRow label="Ganada en total" cents={view.earnedCents} />
          <MoneyRow label="Por cobrar" cents={view.toPayCents} />
          <MoneyRow label="Ya cobrada" cents={view.paidCents} />
        </dl>
        <p className={styles.note}>
          Se gana cuando el paquete está pagado entero. El local te la paga con lo demás, en «Pagos a compañeras».
        </p>
      </section>
      <ReservationList id="rrpp-proximas" title="Próximas noches" items={view.upcoming} empty="Aún no hay reservas con tu enlace para las próximas noches." />
      <ReservationList id="rrpp-pasadas" title="Noches pasadas" items={view.recent} empty="No hay reservas tuyas de las últimas noches." />
    </>
  );
}

function LinkSection({ url }: { url: string }) {
  const [canShare, setCanShare] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  // Solo en el navegador (y no en todos: en el ordenador suele faltar).
  useEffect(() => setCanShare(typeof navigator.share === 'function'), []);
  useEffect(() => {
    if (copied !== 'yes') return;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  function copy() {
    navigator.clipboard.writeText(url).then(
      () => setCopied('yes'),
      () => setCopied('failed'),
    );
  }

  function share() {
    // Cerrar la hoja de compartir también «falla»: no es un error.
    navigator.share({ title: 'Reserva', text: 'Reserva tu mesa con mi enlace:', url }).catch(() => undefined);
  }

  return (
    <section className={styles.section} aria-labelledby="rrpp-enlace">
      <h2 id="rrpp-enlace" className={styles.h2}>
        Tu enlace
      </h2>
      <p className={styles.note}>
        Pásalo a tus clientes o que lean el QR: reservan con tu enlace y la reserva sale aquí, con tu comisión.
      </p>
      <div className={styles.qr}>
        <CobroQr value={url} fallbackPng={null} label="QR de tu enlace para reservar" />
      </div>
      <p className={styles.url}>{url}</p>
      <div className={styles.actions}>
        {canShare ? (
          <Button size="lg" onClick={share}>
            Compartir
          </Button>
        ) : null}
        <Button size="lg" variant={canShare ? 'ghost' : 'primary'} onClick={copy}>
          {copied === 'yes' ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
      <p role="status" className={copied === 'failed' ? styles.error : 'np-sr-only'}>
        {copied === 'failed' ? 'No se ha podido copiar: mantén el dedo sobre el enlace para copiarlo.' : copied === 'yes' ? 'Enlace copiado' : ''}
      </p>
    </section>
  );
}

function MoneyRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div className={styles.moneyRow}>
      <dt>{label}</dt>
      <dd className="np-num">{formatEur(cents)}</dd>
    </div>
  );
}

function ReservationList({ id, title, items, empty }: { id: string; title: string; items: MyPromoterReservation[]; empty: string }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.h2}>
        {title}
      </h2>
      {items.length === 0 ? (
        <EmptyState icon="ticket" title={empty} />
      ) : (
        <ul className={styles.list}>
          {items.map((r) => (
            <ReservationItem key={r.ref} r={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReservationItem({ r }: { r: MyPromoterReservation }) {
  return (
    <li className={styles.item}>
      <div className={styles.itemTop}>
        <span className={styles.night}>{nightLabel(r.nightDate)}</span>
        <span className={styles.pill} data-tone={statusTone(r.status)}>
          {r.statusText}
        </span>
      </div>
      <p className={styles.what}>
        {r.packageName} · {r.entries} {r.entries === 1 ? 'persona' : 'personas'}
      </p>
      <p className={styles.amounts}>
        <span>
          Precio <b className="np-num">{formatEur(r.priceCents)}</b>
        </span>
        <span>
          Pagado <b className="np-num">{formatEur(r.paidCents)}</b>
        </span>
        {r.pendingCents > 0 ? (
          <span>
            Falta <b className="np-num">{formatEur(r.pendingCents)}</b>
          </span>
        ) : null}
      </p>
      <p className={styles.meta}>
        {commissionText(r)} · Ref. {r.ref}
      </p>
    </li>
  );
}

/** Quien no es RRPP (o está de baja): se le dice qué es esto y vuelve a la app. */
export function NotPromoter() {
  return (
    <section className={styles.section}>
      <h2 className={styles.h2}>Esta página es para los RRPP del local</h2>
      <p className={styles.note}>
        Aquí cada RRPP ve su enlace para reservar, sus reservas y su comisión. Si vendes reservados, pide al dueño que te dé de alta como RRPP.
      </p>
      <a href="/" className="np-btn" data-variant="primary" data-size="lg">
        Volver a la app
      </a>
    </section>
  );
}

/** La tarjeta de Inicio (solo a los RRPP): lleva a su página. */
export function RrppHomeLink({ upcoming }: { upcoming: number }) {
  return (
    <a href={RRPP_PATH} className={styles.homeCard}>
      <span className={styles.homeTitle}>Tus reservas de RRPP</span>
      <span className={styles.homeSub}>{upcomingText(upcoming)}</span>
      <Chevron />
    </a>
  );
}
