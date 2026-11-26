import { createHash, randomBytes } from 'node:crypto';
import { BRAND_NAME } from '../../../common/brand';
import { deriveKey, openText, sealText } from '../../auth/aes-gcm';
import { CLUB_BASE_CSS, escapeHtml } from '../../payments/club-ui';

/**
 * El enlace de un uso con una clave nueva (24 h): se guarda el sha256 del
 * token y la clave sellada (AES-GCM con una clave derivada de ENCRYPTION_KEK
 * y el id de la conexión como AAD), que se borra al abrirlo o al caducar.
 */
export const CLAIM_TTL_MS = 24 * 3_600_000;
const CLAIM_PURPOSE = 'nightpay:partner-key-claim:v1';

export interface NewClaim {
  token: string;
  hash: string;
  sealed: string;
  expiresAt: Date;
}

export const claimHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const claimAad = (connectionId: string) => `partner-key-claim:${connectionId}`;

function claimKey(kek: string | undefined): Buffer {
  if (!kek) throw new Error('ENCRYPTION_KEK no está definido: no se puede sellar la clave del enlace');
  return deriveKey(kek, CLAIM_PURPOSE);
}

export function newClaim(kek: string | undefined, connectionId: string, key: string, now: Date): NewClaim {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: claimHash(token),
    sealed: sealText(claimKey(kek), key, claimAad(connectionId)),
    expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
  };
}

export function openClaim(kek: string | undefined, connectionId: string, sealed: string): string {
  return openText(claimKey(kek), sealed, claimAad(connectionId));
}

export const claimUrl = (origin: string, token: string) => `${origin}/partner-key/${token}`;

// ─── El correo ─────────────────────────────────────────────────────────

export function claimEmail(partner: string, venue: string, link: string): { subject: string; text: string; html: string } {
  const text =
    `${venue} te envía la clave de ${partner} para la API de OxioPay. Ábrela aquí: ${link}. ` +
    'Caduca en 24 horas y se abre una sola vez. Guárdala en tu servidor, nunca en un cajero. ' +
    `Si no la esperabas, no la abras y avisa a ${venue}.`;
  const html =
    `<p>${escapeHtml(venue)} te envía la clave de ${escapeHtml(partner)} para la API de OxioPay. ` +
    `Ábrela aquí: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a>.</p>` +
    '<p>Caduca en 24 horas y se abre una sola vez. Guárdala en tu servidor, nunca en un cajero.</p>' +
    `<p>Si no la esperabas, no la abras y avisa a ${escapeHtml(venue)}.</p>`;
  return { subject: `${BRAND_NAME}: clave de ${partner} para ${venue}`, text, html };
}

// ─── Las páginas (como legal-page.ts: nada de fuera) ───────────────────

const PAGE_CSS = `
.pk{width:100%;max-width:32rem;margin:0 auto;padding:2.5rem 1rem calc(2.5rem + env(safe-area-inset-bottom));line-height:1.55;color:var(--mute)}
.pk h1{margin:0 0 1rem;color:var(--fg);font-size:1.5rem;font-weight:600;line-height:1.2}
.pk p{margin:.75rem 0}
.pk .en{margin-top:.125rem;font-size:.875rem;color:var(--dim)}
.pk .key{display:block;margin:1.25rem 0;padding:1rem;border:1px solid var(--line);border-radius:var(--r-field);background:var(--surface-2);color:var(--fg);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:1rem;word-break:break-all;user-select:all}
.pk form{margin:1.5rem 0 0}
.pk .btn{min-height:2.75rem;margin-top:1rem}
`;

/** Un texto y, debajo, su inglés literal. */
const both = (es: string, en: string, tag: 'h1' | 'p' = 'p') =>
  `<${tag}>${escapeHtml(es)}</${tag}><p class="en" lang="en">${escapeHtml(en)}</p>`;

function page(title: string, body: string, script = ''): string {
  return (
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">' +
    `<title>${escapeHtml(title)}</title><style>${CLUB_BASE_CSS}${PAGE_CSS}</style></head>` +
    `<body><main class="pk">${body}</main>${script}</body></html>`
  );
}

/** GET: no cambia nada (los antivirus abren los enlaces); el botón la enseña. */
export function claimLandingPage(partner: string, venue: string, token: string): string {
  return page(
    `Clave de ${partner} para ${venue}`,
    both(`Clave de ${partner} para ${venue}`, `Key of ${partner} for ${venue}`, 'h1') +
      both(
        'Solo se puede ver una vez. Ábrela cuando vayas a guardarla en tu servidor.',
        'It can be seen only once. Open it when you are about to store it on your server.',
      ) +
      `<form method="post" action="/partner-key/${encodeURIComponent(token)}"><input type="hidden" name="ver" value="1">` +
      '<button class="btn" type="submit">Ver la clave · Show the key</button></form>',
  );
}

export function claimKeyPage(key: string): string {
  return page(
    'Esta es tu clave',
    both('Esta es tu clave', 'This is your key', 'h1') +
      `<code class="key" id="k">${escapeHtml(key)}</code>` +
      '<button class="btn" type="button" id="c">Copiar · Copy</button>' +
      both(
        'Guárdala en tu servidor, nunca en una caja ni en un cajero. Esta página no se puede volver a abrir.',
        'Store it on your server, never in a till or an ATM. This page cannot be opened again.',
      ),
    '<script>document.getElementById("c").addEventListener("click",function(){navigator.clipboard&&navigator.clipboard.writeText(document.getElementById("k").textContent)})</script>',
  );
}

export function claimInvalidPage(): string {
  return page(
    'Este enlace ya no vale',
    both(
      'Este enlace ya no vale. Pide al local que te envíe uno nuevo.',
      'This link is no longer valid. Ask the venue to send you a new one.',
      'h1',
    ),
  );
}
