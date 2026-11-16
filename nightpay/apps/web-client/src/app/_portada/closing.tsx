import type { ReactNode } from 'react';
import { CONTACT_EMAIL, staffAppUrl } from '@/lib/customer-pages';
import { Eyebrow, MAIL, PARTY_MAIL, cx } from './bits';
import { PHONE_DISPLAY, PHONE_HREF, PHONE_INTL, STAFF } from './content';
import { Icon } from './icons';
import c from './sections.module.css';
import s from '../landing.module.css';

export function Party() {
  return (
    <section className={cx(c.section, c.partySection)} aria-labelledby="party-title">
      <div className={s.container}>
        <div className={c.party}>
          <div>
            <Eyebrow className={c.inkText}>OxioParty</Eyebrow>
            <h2 id="party-title" className={cx(s.h2, c.inkText)}>
              ¿Peñas, fiestas o casetas?
            </h2>
            <p className={c.partyText}>
              Para eso tenemos OxioParty: la versión de OxioPay pensada para peñas, fiestas populares y casetas.
            </p>
          </div>
          <a className={cx(s.btn, s.btnDark, c.partyBtn)} href={PARTY_MAIL}>
            Pregúntanos por OxioParty
          </a>
        </div>
      </div>
    </section>
  );
}

/** Contacto sin formulario: teléfono y email. */
export function Contact() {
  return (
    <section id="contacto" className={cx(c.section, c.contact)} aria-labelledby="contact-title">
      <div className={cx(s.container, c.split)}>
        <div>
          <Eyebrow>Contacto</Eyebrow>
          <h2 id="contact-title" className={s.h2}>
            ¿Tienes un local?<span className={s.dim}> Hablemos.</span>
          </h2>
          <p className={s.lead}>Llámanos o escríbenos y te contamos cómo funciona OxioPay en tu local.</p>
        </div>
        <div className={c.contactCard}>
          <dl className={c.contactList}>
            <div className={c.contactRow}>
              <dt>
                <Icon name="phone" size={18} stroke={2.2} />
                Teléfono
              </dt>
              <dd>{PHONE_INTL}</dd>
            </div>
            <div className={c.contactRow}>
              <dt>
                <Icon name="mail" size={18} stroke={2.2} />
                Email
              </dt>
              <dd>{CONTACT_EMAIL}</dd>
            </div>
          </dl>
          <div className={c.contactActions}>
            <a className={cx(s.btn, s.btnLime, s.btnBig)} href={PHONE_HREF}>
              Llamar al {PHONE_DISPLAY}
            </a>
            <a className={cx(s.btn, s.btnLine, s.btnBig)} href={MAIL}>
              Escribir un email
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Solo hechos que ya están en la página o comprobados en el código. */
const FAQ: readonly { q: string; a: ReactNode }[] = [
  {
    q: '¿Necesito una app?',
    a: 'No. Escaneas el QR que te enseña el personal y pagas desde tu móvil. No hace falta instalar nada ni registrarse.',
  },
  {
    q: '¿Es seguro pagar?',
    a: 'La tarjeta la escribes en la página segura del banco, no en OxioPay. Antes de pagar ves el total, y tu saldo está protegido con PIN o Face ID.',
  },
  {
    q: '¿Qué es la ficha?',
    a: 'Es tu saldo en una ficha: te la dan en recepción, en los locales que la usan. Para pagar, acércala al móvil del personal y pon tu PIN. Si la pierdes, avisa al personal: bloqueamos el saldo para que nadie lo use.',
  },
  {
    q: '¿Puedo pagar con bitcoin?',
    a: 'Con bitcoin puedes cargar tu saldo en recepción, en los locales que lo aceptan, y después pagas con ese saldo. En la barra no se paga con bitcoin. Próximamente también podrás pagar tu reservado con bitcoin: la señal y el resto.',
  },
  {
    q: '¿Qué pasa con el saldo que me sobra?',
    a: 'Si te sobra saldo, te lo devolvemos cuando lo pidas. El saldo que cargaste con bitcoin se devuelve en euros.',
  },
  {
    q: '¿En qué idiomas está la página de pago?',
    a: 'En español, inglés, francés y portugués.',
  },
  {
    q: '¿Cuánto cuesta para mi local?',
    a: (
      <>
        Llámanos al <a href={PHONE_HREF}>{PHONE_DISPLAY}</a> o escríbenos a <a href={MAIL}>{CONTACT_EMAIL}</a>.
      </>
    ),
  },
];

/** Acordeón con <details>: se abre y se cierra sin JavaScript. */
export function Faq() {
  return (
    <section id="preguntas" className={c.section} aria-labelledby="faq-title">
      <div className={s.container}>
        <div className={s.center}>
          <Eyebrow>Preguntas</Eyebrow>
          <h2 id="faq-title" className={s.h2}>
            Preguntas frecuentes
          </h2>
        </div>
        <div className={c.faqList}>
          {FAQ.map(({ q, a }) => (
            <details key={q} className={c.faqItem}>
              <summary className={c.faqQ}>
                <span>{q}</span>
                <Icon name="chevron" size={18} stroke={2.4} className={c.faqChev} />
              </summary>
              <p className={c.faqA}>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Access() {
  return (
    <section id="acceso" className={cx(c.section, c.access)} aria-labelledby="access-title">
      <div className={s.container}>
        <Eyebrow>Personal</Eyebrow>
        <h2 id="access-title" className={s.h2}>
          Acceso del personal
        </h2>
        <p className={s.lead}>Cada uno entra con su email y su contraseña en su app.</p>
        <ul className={c.accessList}>
          {STAFF.map(([app, name, who]) => (
            <li key={app}>
              <a className={c.accessCard} href={staffAppUrl(app)}>
                <span className={c.accessName}>{name}</span>
                <span className={c.accessWho}>{who}</span>
                <Icon name="arrow" size={22} stroke={2} className={c.accessArrow} />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
