import type { Metadata } from 'next';
import { Logo } from '@nightpay/ui';
import { CONTACT_EMAIL, LEGAL_LINKS, legalUrl, staffAppUrl, type StaffApp } from '@/lib/customer-pages';
import s from './landing.module.css';

/**
 * Portada de OxioPay: qué es, cómo se paga, para locales, la entrada del
 * personal y los textos legales. Al pago y al saldo se sigue llegando con el
 * enlace del QR (/pay/…, /wallet/…), no desde aquí.
 * Solo cuenta lo que OxioPay hace hoy: sin cifras, reseñas ni promesas.
 */

export const metadata: Metadata = {
  title: 'OxioPay — Pagar con el móvil en locales de ocio',
  description:
    'Escanea el QR que te enseña el personal y paga desde tu móvil con tarjeta, Apple Pay, Google Pay o tu saldo. Sin app ni registro.',
  // La portada sí se puede encontrar; las páginas de pago siguen fuera de los buscadores (layout).
  robots: { index: true, follow: true },
};

const MAIL = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('OxioPay para mi local')}`;
const PARTY_MAIL = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('OxioParty para mi fiesta')}`;

const STEPS = [
  ['Escanea el QR', 'El personal te lo enseña en su móvil o en el datáfono. No hace falta instalar nada ni registrarse.'],
  [
    'Elige cómo pagar',
    'Tarjeta, Apple Pay, Google Pay, tu saldo o bitcoin, donde lo aceptan. Ves el total antes de pagar y la propina la decides tú.',
  ],
  ['Pagado', 'En cuanto el banco lo confirma, lo ves en pantalla y puedes guardar el justificante.'],
] as const;

const FOR_CLIENTS = [
  'Sin app ni registro: solo tu móvil.',
  'La tarjeta la escribes en la página segura del banco, no en OxioPay.',
  'Saldo prepago, protegido con PIN o Face ID.',
  'Si te sobra saldo, te lo devolvemos cuando lo pidas.',
] as const;

const FOR_VENUES = [
  'Cobra con QR, con datáfono o con el saldo del cliente.',
  'Cobra también en bitcoin, si quieres: con Lightning, al momento.',
  'Fideliza: el saldo de tus clientes vale en todos tus locales y les espera para la próxima visita, también en Google Wallet.',
  'Un panel con lo cobrado cada noche.',
  'Las comisiones del personal se calculan solas.',
  'Avisos al momento en Telegram.',
] as const;

const STAFF: readonly (readonly [StaffApp, string, string])[] = [
  ['admin', 'Panel', 'Dueños y encargados'],
  ['operator', 'App de cobro', 'Personal del local'],
  ['tpv', 'TPV', 'Caja y barra'],
];

export default function HomePage() {
  return (
    <div className={s.page}>
      <header className={s.top}>
        <Logo height="1.75rem" />
        <a className={s.topLink} href="#acceso">
          Acceso del personal
        </a>
      </header>

      <main>
        <section className={s.hero} aria-labelledby="hero-title">
          <div className={s.heroText}>
            <p className={s.eyebrow}>Pagos y fidelización para locales de ocio</p>
            <h1 id="hero-title" className={s.title}>
              Escanea, paga y <span className={s.accent}>sigue la noche.</span>
            </h1>
            <p className={s.lead}>
              OxioPay es la forma de pagar en los locales que la usan: escaneas el QR que te enseña el personal y
              pagas desde tu móvil con tarjeta, Apple Pay, Google Pay, tu saldo o bitcoin, donde lo aceptan.
            </p>
            <p className={s.leadEn} lang="en">
              Scan the QR code the staff show you and pay from your phone.
            </p>
            <div className={s.actions}>
              <a className={s.btn} href={MAIL}>
                ¿Tienes un local? Escríbenos
              </a>
              <a className={s.btnGhost} href="#como-funciona">
                Cómo funciona
              </a>
            </div>
          </div>
          <PhoneMock />
        </section>

        <section id="como-funciona" className={s.section} aria-labelledby="steps-title">
          <h2 id="steps-title" className={s.h2}>
            Cómo funciona
          </h2>
          <ol className={s.steps}>
            {STEPS.map(([title, text], i) => (
              <li key={title} className={s.step}>
                <span className={s.stepNum} aria-hidden="true">
                  {i + 1}
                </span>
                <h3 className={s.h3}>{title}</h3>
                <p className={s.text}>{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className={`${s.section} ${s.split}`} aria-label="Para clientes y para locales">
          <div className={s.panel}>
            <h2 className={s.h2}>Para clientes</h2>
            <List items={FOR_CLIENTS} />
          </div>
          <div className={`${s.panel} ${s.panelVenue}`}>
            <h2 className={s.h2}>Para locales</h2>
            <List items={FOR_VENUES} />
            <a className={s.btn} href={MAIL}>
              Escríbenos
            </a>
          </div>
        </section>

        <section className={s.section} aria-labelledby="party-title">
          <div className={s.party}>
            <div>
              <p className={s.eyebrow}>OxioParty</p>
              <h2 id="party-title" className={s.h2}>
                ¿Peñas, fiestas o casetas?
              </h2>
              <p className={s.text}>
                Para eso tenemos OxioParty: la versión de OxioPay pensada para peñas, fiestas populares y casetas.
              </p>
            </div>
            <a className={s.btn} href={PARTY_MAIL}>
              Pregúntanos por OxioParty
            </a>
          </div>
        </section>

        <section id="acceso" className={s.section} aria-labelledby="access-title">
          <h2 id="access-title" className={s.h2}>
            Acceso del personal
          </h2>
          <p className={s.text}>Cada uno entra con su email y su contraseña en su app.</p>
          <ul className={s.access}>
            {STAFF.map(([app, name, who]) => (
              <li key={app}>
                <a className={s.accessCard} href={staffAppUrl(app)}>
                  <span className={s.accessName}>{name}</span>
                  <span className={s.accessWho}>{who}</span>
                  <span className={s.arrow} aria-hidden="true">
                    →
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className={s.foot}>
        <nav aria-label="Textos legales" className={s.legal}>
          {LEGAL_LINKS.map(([doc, label]) => (
            <a key={doc} href={legalUrl(doc)}>
              {label}
            </a>
          ))}
        </nav>
        <p className={s.owner}>
          OxioPay es un servicio de JOVEDAR PAS S.L. · <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </footer>
    </div>
  );
}

function List({ items }: { items: readonly string[] }) {
  return (
    <ul className={s.list}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** La pantalla de pago, dibujada (decorativa: un ejemplo, no un cobro). */
function PhoneMock() {
  return (
    <div className={s.phone} aria-hidden="true">
      <p className={s.phoneLabel}>Total</p>
      <p className={s.phoneAmount}>35,00 €</p>
      <p className={s.phoneTip}>Propina: la eliges tú</p>
      <span className={s.phonePay}>Pagar con tarjeta</span>
      <span className={s.phoneAlt}>Apple Pay · Google Pay</span>
      <span className={s.phoneAlt}>Pagar con mi saldo</span>
      <p className={s.phoneSecure}>Pago seguro</p>
    </div>
  );
}
