import { CONTACT_EMAIL, LEGAL_LINKS, legalUrl } from '@/lib/customer-pages';
import { WORDMARK, cx } from './bits';
import { MENU, PHONE_DISPLAY, PHONE_HREF, PHONE_INTL } from './content';
import { Icon } from './icons';
import s from '../landing.module.css';

/** Franja de arriba con el teléfono (desde tableta, como en oxiocard). */
export function Topbar() {
  return (
    <div className={s.topbar}>
      <div className={cx(s.container, s.topbarInner)}>
        <a className={s.topPhone} href={PHONE_HREF}>
          <Icon name="phone" size={15} stroke={2.2} />
          <span className={s.srOnly}>Llámanos al </span>
          {PHONE_DISPLAY}
        </a>
      </div>
    </div>
  );
}

/**
 * Logo, menú y «Acceso del personal». En el móvil, el menú es un <details>:
 * se abre y se cierra sin JavaScript.
 */
export function Header() {
  return (
    <header className={s.header}>
      <div className={cx(s.container, s.headerInner)}>
        <a className={s.logoLink} href="#inicio">
          <img className={s.logo} src={WORDMARK.src} width={WORDMARK.width} height={WORDMARK.height} alt="OxioPay" />
        </a>
        <nav className={s.nav} aria-label="Menú principal">
          <ul className={s.navList}>
            {MENU.map(([href, label]) => (
              <li key={href}>
                <a className={s.navLink} href={href}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <a className={cx(s.btn, s.btnLime, s.navCta)} href="#acceso">
          Acceso del personal
        </a>
        <details className={s.menu}>
          <summary className={s.burger}>
            <Icon name="menu" size={26} stroke={2} className={s.burgerOpen} />
            <Icon name="x" size={26} stroke={2} className={s.burgerClose} />
            <span className={s.srOnly}>Menú</span>
          </summary>
          <div className={s.menuPanel}>
            <nav aria-label="Menú principal">
              <ul className={s.menuList}>
                {MENU.map(([href, label]) => (
                  <li key={href}>
                    <a href={href}>{label}</a>
                  </li>
                ))}
              </ul>
            </nav>
            <a className={cx(s.btn, s.btnLime, s.menuCta)} href="#acceso">
              Acceso del personal
            </a>
            <a className={s.menuPhone} href={PHONE_HREF}>
              <Icon name="phone" size={16} stroke={2.2} />
              {PHONE_INTL}
            </a>
          </div>
        </details>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className={s.footer}>
      <div className={cx(s.container, s.footGrid)}>
        <div>
          <img
            className={s.footLogo}
            src={WORDMARK.src}
            width={WORDMARK.width}
            height={WORDMARK.height}
            alt="OxioPay"
            loading="lazy"
            decoding="async"
          />
          <p className={s.footText}>Pagos y fidelización para locales de ocio. Escanea, paga y sigue la noche.</p>
        </div>
        <nav aria-labelledby="pie-menu">
          <p id="pie-menu" className={s.footTitle}>
            Menú
          </p>
          <ul className={s.footMenu}>
            <li>
              <a href="#inicio">Inicio</a>
            </li>
            {MENU.map(([href, label]) => (
              <li key={href}>
                <a href={href}>{label}</a>
              </li>
            ))}
            <li>
              <a href="#acceso">Acceso del personal</a>
            </li>
          </ul>
        </nav>
        <div className={s.footContact}>
          <p className={s.footTitle}>
            <Icon name="phone" size={16} stroke={2.2} />
            Teléfono
          </p>
          <a className={s.footLink} href={PHONE_HREF}>
            {PHONE_INTL}
          </a>
          <p className={s.footTitle}>
            <Icon name="mail" size={16} stroke={2.2} />
            Email
          </p>
          <a className={s.footLink} href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </div>
      </div>
      <div className={s.subfoot}>
        <div className={cx(s.container, s.subfootInner)}>
          <p className={s.copy}>
            © OxioPay{' '}
            <span className={s.copySep} aria-hidden="true">
              |
            </span>{' '}
            OxioPay es un servicio de JOVEDAR&nbsp;PAS&nbsp;S.L.
          </p>
          <nav aria-label="Textos legales">
            <ul className={s.legal}>
              {LEGAL_LINKS.map(([doc, label]) => (
                <li key={doc}>
                  <a href={legalUrl(doc)}>{label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
