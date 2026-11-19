import { Eyebrow, MAIL, Points, WORDMARK, cx } from './bits';
import {
  BITCOIN_POINTS,
  FOR_CLIENTS,
  FOR_VENUES,
  PHONE_DISPLAY,
  PHONE_HREF,
  SHOTS,
  STEPS,
  VERSUS,
  type Point,
} from './content';
import { Icon, type IconName } from './icons';
import { Phone } from './Phone';
import c from './sections.module.css';
import s from '../landing.module.css';

const INTRO_CARDS: readonly (readonly [IconName, string])[] = [
  ['phoneQr', 'Sin app ni registro'],
  ['cards', 'Tarjeta, Apple Pay, Google Pay o saldo'],
  ['shield', 'Saldo con PIN, Face ID o huella'],
];

/** Como «Tarjeta global» en oxiocard: titular centrado y tres tarjetas lima. */
export function Intro() {
  return (
    <section id="oxiopay" className={cx(c.section, c.intro)} aria-labelledby="intro-title">
      <div className={s.container}>
        <div className={c.introHead}>
          <Eyebrow>Pagos y fidelización</Eyebrow>
          <h2 id="intro-title" className={s.h2}>
            La forma de pagar en los locales que la usan.
          </h2>
          <p className={s.kicker}>Conoce OxioPay</p>
          <p className={s.lead}>El personal te enseña el QR y pagas desde tu móvil, sin instalar nada.</p>
        </div>
        <ul className={c.cards}>
          {INTRO_CARDS.map(([icon, title]) => (
            <li key={title} className={c.card}>
              <Icon name={icon} size={64} stroke={1.25} className={c.cardIcon} />
              <h3 className={c.cardTitle}>{title}</h3>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Los tres pasos (en oxiocard, «Operatividad»): sin carrusel, los tres a la vista. */
export function HowItWorks() {
  const art = [
    <div key="qr" className={c.qrTile} aria-hidden="true">
      <Icon name="qr" size={112} stroke={1.5} />
    </div>,
    <div key="pago" className={c.stepCrop}>
      <Phone shot={SHOTS.pago} className={c.stepPhone} />
    </div>,
    <div key="pagado" className={c.stepCrop}>
      <Phone shot={SHOTS.pagado} className={c.stepPhone} />
    </div>,
  ];
  return (
    <section id="como-funciona" className={cx(c.section, c.how)} aria-labelledby="how-title">
      <div className={s.container}>
        <Eyebrow>Cómo funciona</Eyebrow>
        <h2 id="how-title" className={cx(s.h2, c.howTitle)}>
          Tres pasos, sin instalar nada.
        </h2>
        <ol className={c.steps}>
          {STEPS.map((step, i) => (
            <li key={step.title} className={c.step}>
              <div className={c.stepArt}>{art[i]}</div>
              <div className={c.stepText}>
                <Eyebrow className={c.stepEyebrow}>Paso 0{i + 1}</Eyebrow>
                <h3 className={c.stepTitle}>{step.title}</h3>
                <p className={s.lead}>{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** «Para clientes» con el aire de «Beneficios de oxiocard»: móvil con la placa lima y la lista. */
export function Clients() {
  return (
    <section id="clientes" className={cx(c.section, c.clients)} aria-labelledby="clients-title">
      <div className={cx(s.container, c.split)}>
        <div className={c.art}>
          <div className={c.artFrame}>
            <Phone shot={SHOTS.saldo} className={c.clientsPhone} />
            <p className={c.badge} aria-hidden="true">
              <span className={c.badgeBig}>Sin</span>
              <span className={c.badgeLine} />
              <span className={c.badgeText}>app ni registro</span>
            </p>
          </div>
        </div>
        <div className={c.splitText}>
          <Eyebrow>Para clientes</Eyebrow>
          <h2 id="clients-title" className={s.h2}>
            Pagar con{' '}
            <img
              className={c.h2Logo}
              src={WORDMARK.src}
              width={WORDMARK.width}
              height={WORDMARK.height}
              alt="OxioPay"
              loading="lazy"
              decoding="async"
            />
          </h2>
          <Points items={FOR_CLIENTS} />
          <div className={c.callout}>
            <Icon name="tap" size={32} stroke={1.8} className={c.calloutIcon} />
            <p>
              <strong>La ficha:</strong> en los locales que la usan, te la dan en recepción, unida a tu saldo. Para
              pagar, acércala al móvil del personal y pon tu PIN. Los importes pequeños pueden ir sin PIN, si el
              local lo permite.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Venues() {
  return (
    <section id="locales" className={c.section} aria-labelledby="venues-title">
      <div className={s.container}>
        <div className={s.center}>
          <Eyebrow>Para locales</Eyebrow>
          <h2 id="venues-title" className={s.h2}>
            Lo que OxioPay hace por tu local
          </h2>
          <p className={s.lead}>Cobros, saldo de tus clientes, reservados y comisiones del personal.</p>
        </div>
        <ul className={c.tiles}>
          {FOR_VENUES.map(([icon, title, text]) => (
            <li key={title} className={c.tile}>
              <span className={c.tileIcon}>
                <Icon name={icon} size={26} stroke={1.8} />
              </span>
              <h3 className={c.tileTitle}>{title}</h3>
              <p className={c.tileText}>{text}</p>
            </li>
          ))}
        </ul>
        <div className={c.ctaRow}>
          <a className={cx(s.btn, s.btnLime)} href={MAIL}>
            Escríbenos
          </a>
          <a className={cx(s.btn, s.btnLine)} href={PHONE_HREF}>
            Llámanos: {PHONE_DISPLAY}
          </a>
        </div>
      </div>
    </section>
  );
}

/** Bitcoin: para cargar saldo y para pagar el reservado, nunca en la barra. Ver la nota de content.ts. */
export function Bitcoin() {
  return (
    <section id="bitcoin" className={cx(c.section, c.btc)} aria-labelledby="btc-title">
      <div className={cx(s.container, c.split)}>
        <div className={c.splitTextStart}>
          <Eyebrow>Bitcoin</Eyebrow>
          <h2 id="btc-title" className={s.h2}>
            <span className={s.dim}>Carga tu saldo </span>con bitcoin
          </h2>
          <p className={cx(s.lead, s.leadGap)}>
            En los locales que lo aceptan. Después pagas con tu saldo, como siempre.
          </p>
          <Points items={BITCOIN_POINTS} />
          <div className={c.rsv}>
            <div className={c.rsvCrop}>
              <Phone shot={SHOTS.reservado} className={c.rsvPhone} />
            </div>
            <div>
              <h3 className={c.rsvTitle}>Reservados</h3>
              <p className={c.rsvText}>Paga tu reservado con bitcoin: la señal y el resto.</p>
            </div>
          </div>
        </div>
        <div className={cx(c.art, c.btcArt)}>
          <Phone shot={SHOTS.cargarBitcoin} className={c.btcFront} />
          <Phone shot={SHOTS.bitcoinQr} className={c.btcBack} />
        </div>
      </div>
    </section>
  );
}

function VersusLine({ point, yes }: { point: Point; yes: boolean }) {
  return (
    <p className={c.vsLine}>
      <span className={cx(c.vsMark, yes ? c.vsYes : c.vsNo)}>
        <Icon name={yes ? 'check' : 'x'} size={14} stroke={3} />
      </span>
      <strong>{point[0]}</strong> {point[1]}
    </p>
  );
}

/** Como «Banca tradicional VS Oxiocard», con hechos comprobables. */
export function Versus() {
  return (
    <section className={cx(c.section, c.vs)} aria-labelledby="vs-title">
      <div className={s.container}>
        <div className={s.center}>
          <Eyebrow>Comparativa</Eyebrow>
          <h2 id="vs-title" className={s.h2}>
            Efectivo y datáfono de siempre <span className={c.vsWord}>vs</span> OxioPay
          </h2>
        </div>
        <div className={c.vsGrid}>
          {VERSUS.map((column) => (
            <div key={column[0]?.topic}>
              {column.map((row) => (
                <div key={row.topic} className={c.vsTopic}>
                  <h3 className={c.vsTopicTitle}>{row.topic}</h3>
                  <h4 className={c.vsSide}>De siempre</h4>
                  <VersusLine point={row.before} yes={false} />
                  <hr className={c.vsRule} />
                  <h4 className={c.vsSide}>Con OxioPay</h4>
                  <VersusLine point={row.after} yes />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
