import { isIP } from 'node:net';

/**
 * La URL del BTCPay la escribe el dueño del local y la llama el servidor: es el
 * punto por donde un dato de un usuario decide a dónde se conecta el API (SSRF).
 * Aquí solo se mira la URL escrita y las direcciones; lo de resolver el nombre
 * y fijar la IP de la conexión está en btcpay-net.ts.
 */

export type BtcpayUrlErrorCode =
  | 'INVALID'
  | 'NOT_HTTPS'
  | 'BAD_PORT'
  | 'CREDENTIALS'
  | 'HAS_PATH'
  | 'IP_LITERAL'
  | 'LOCAL_NAME'
  | 'PRIVATE_ADDRESS'
  | 'NO_ADDRESS';

export type ParsedBtcpayUrl =
  | { ok: true; origin: string; host: string }
  | { ok: false; code: BtcpayUrlErrorCode; message: string };

const MAX_URL_LENGTH = 2048;
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.private'];

/** Mensajes para el dueño (en castellano, sin jerga). */
export const BTCPAY_URL_MESSAGES: Readonly<Record<BtcpayUrlErrorCode, string>> = {
  INVALID: 'La dirección de BTCPay no es válida. Tiene que ser algo como https://pay.tulocal.es',
  NOT_HTTPS: 'La dirección de BTCPay tiene que empezar por https://',
  BAD_PORT: 'La dirección de BTCPay no puede llevar otro puerto que el de siempre (443).',
  CREDENTIALS: 'La dirección de BTCPay no puede llevar usuario ni contraseña.',
  HAS_PATH: 'Escribe solo el dominio de BTCPay, sin nada detrás (por ejemplo https://pay.tulocal.es).',
  IP_LITERAL: 'Usa el nombre de tu BTCPay (pay.tulocal.es), no una dirección con números.',
  LOCAL_NAME: 'Esa dirección es de una red interna: BTCPay tiene que estar en internet con su propio dominio.',
  PRIVATE_ADDRESS: 'Esa dirección apunta a una red interna: BTCPay tiene que estar en internet con su propio dominio.',
  NO_ADDRESS: 'No se encuentra esa dirección de BTCPay. Revisa que esté bien escrita.',
};

function fail(code: BtcpayUrlErrorCode): ParsedBtcpayUrl {
  return { ok: false, code, message: BTCPAY_URL_MESSAGES[code] };
}

export function parseBtcpayUrl(raw: unknown): ParsedBtcpayUrl {
  if (typeof raw !== 'string') return fail('INVALID');
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH) return fail('INVALID');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('INVALID');
  }
  if (url.protocol !== 'https:') return fail(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? 'NOT_HTTPS' : 'INVALID');
  if (url.username !== '' || url.password !== '') return fail('CREDENTIALS');
  if (url.port !== '' && url.port !== '443') return fail('BAD_PORT');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') return fail('HAS_PATH');
  const host = url.hostname.toLowerCase();
  if (host === '') return fail('INVALID');
  // `new URL` ya pasa 2130706433, 0x7f.1 o 127.1 a 127.0.0.1; los corchetes son IPv6.
  if (host.startsWith('[') || isIP(host) !== 0) return fail('IP_LITERAL');
  const bare = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!bare.includes('.') || LOCAL_SUFFIXES.some((s) => bare.endsWith(s)) || bare === 'localhost') return fail('LOCAL_NAME');
  return { ok: true, origin: `https://${host}`, host };
}

// ─── Direcciones prohibidas ───────────────────────────────────────────

type Cidr4 = readonly [string, number];

const FORBIDDEN_V4: readonly Cidr4[] = [
  ['0.0.0.0', 8], // «esta red» y 0.0.0.0
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local y metadatos de la nube (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservado y 255.255.255.255
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inCidr4(n: number, [base, bits]: Cidr4): boolean {
  const b = v4ToInt(base);
  if (b === null) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(b / size);
}

/** IPv6 → 16 bytes (o null si no es una dirección). Acepta «::» y el final a.b.c.d. */
function v6ToBytes(input: string): number[] | null {
  const noZone = input.split('%')[0] ?? '';
  if (noZone === '' || !/^[0-9a-fA-F:.]+$/.test(noZone)) return null;
  let text = noZone;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = v4ToInt(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 2 ** 24), Math.floor(v4 / 2 ** 16) % 256, Math.floor(v4 / 256) % 256, v4 % 256);
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((g) => [g >> 8, g & 255]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function prefixMatches(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i += 1) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

const FORBIDDEN_V6: ReadonlyArray<readonly [number[], number]> = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128], // ::
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128], // ::1
  [[0x01, 0, 0, 0, 0, 0, 0, 0], 64], // 100::/64 descarte
  [[0x20, 0x01, 0, 0], 32], // 2001::/32 Teredo
  [[0x20, 0x01, 0x0d, 0xb8], 32], // 2001:db8::/32 documentación
  [[0x20, 0x02], 16], // 2002::/16 6to4
  [[0xfc], 7], // fc00::/7 locales únicas
  [[0xfe, 0x80], 10], // fe80::/10 link-local
  [[0xfe, 0xc0], 10], // fec0::/10 site-local
  [[0xff], 8], // multicast
];

/** true si el servidor NO debe conectarse a esa dirección (o si no es una dirección). */
export function isForbiddenIp(ip: string): boolean {
  if (typeof ip !== 'string') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const n = v4ToInt(ip);
    return n === null || FORBIDDEN_V4.some((c) => inCidr4(n, c));
  }
  const bytes = v6ToBytes(ip);
  if (!bytes) return true;
  // IPv4 dentro de IPv6: ::ffff:a.b.c.d (mapeada) y 64:ff9b::/96 (NAT64).
  const mapped = prefixMatches(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96);
  const nat64 = prefixMatches(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96);
  if (mapped || nat64) {
    const n = (bytes[12] ?? 0) * 2 ** 24 + ((bytes[13] ?? 0) << 16) + ((bytes[14] ?? 0) << 8) + (bytes[15] ?? 0);
    return FORBIDDEN_V4.some((c) => inCidr4(n, c));
  }
  return FORBIDDEN_V6.some(([prefix, bits]) => prefixMatches(bytes, prefix, bits));
}
