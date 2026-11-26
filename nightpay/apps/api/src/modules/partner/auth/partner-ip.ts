import { BlockList, isIP } from 'node:net';
import { isCloudflareAddress, isInternalAddress, normalizeIp } from '../../../common/http/client-ip';

/**
 * Las IP de la API de socios: las que el socio declara (consola) y las de cada
 * clave (el dueño, dentro de las del socio). Se compara la IP entera de
 * clientIp(), nunca la clave /64 de los topes (rateLimitIpKey), con
 * net.BlockList. Nunca valen las internas, las de Cloudflare (la IP de verdad
 * viene detrás), 100.64.0.0/10, la multidifusión ni las sin especificar.
 */

export type IpEntryKind = 'connection' | 'partner';

interface IpEntry {
  address: string;
  prefix: number;
  family: 4 | 6;
}

const OTHER_FORBIDDEN = new BlockList();
OTHER_FORBIDDEN.addSubnet('100.64.0.0', 10, 'ipv4');
OTHER_FORBIDDEN.addSubnet('224.0.0.0', 4, 'ipv4');
OTHER_FORBIDDEN.addSubnet('0.0.0.0', 8, 'ipv4');
OTHER_FORBIDDEN.addSubnet('ff00::', 8, 'ipv6');
OTHER_FORBIDDEN.addAddress('::', 'ipv6');

const ipType = (family: 4 | 6) => (family === 4 ? 'ipv4' : 'ipv6');
const maxPrefix = (family: 4 | 6) => (family === 4 ? 32 : 128);
/** Lo más ancho que vale: una clave, una dirección (IPv6 desde /64); un socio, un /24 o un /48. */
const MIN_PREFIX: Readonly<Record<IpEntryKind, Record<4 | 6, number>>> = {
  connection: { 4: 32, 6: 64 },
  partner: { 4: 24, 6: 48 },
};

function parseIpEntry(raw: string): IpEntry | null {
  const [addr, len, ...rest] = raw.trim().split('/');
  if (rest.length > 0 || (len !== undefined && !/^\d{1,3}$/.test(len))) return null;
  const address = normalizeIp(addr);
  if (!address) return null;
  const family = isIP(address) as 4 | 6;
  const prefix = len === undefined ? maxPrefix(family) : Number(len);
  return prefix > maxPrefix(family) ? null : { address: address.toLowerCase(), prefix, family };
}

export function isForbiddenAddress(ip: string): boolean {
  const address = normalizeIp(ip);
  if (!address) return true;
  return isInternalAddress(address) || isCloudflareAddress(address) || OTHER_FORBIDDEN.check(address, ipType(isIP(address) as 4 | 6));
}

/** null si vale; si no, el texto del 422 (PARTNER_IP_INVALID) con la IP. */
export function ipEntryProblem(raw: string, kind: IpEntryKind): string | null {
  const shown = raw.trim().slice(0, 64) || '(vacía)';
  const e = parseIpEntry(raw);
  const message =
    kind === 'connection'
      ? `${shown} no vale: direcciones sueltas y públicas (IPv4, o IPv6 de /64 a /128).`
      : `${shown} no vale: direcciones públicas, como mucho un /24 (IPv4) o un /48 (IPv6).`;
  if (!e || e.prefix < MIN_PREFIX[kind][e.family] || isForbiddenAddress(e.address)) return message;
  return null;
}

/** Más de una dirección (necesita motivo en un socio). */
export function entryWiderThanAddress(raw: string): boolean {
  const e = parseIpEntry(raw);
  return e !== null && e.prefix < maxPrefix(e.family);
}

/** Como se guarda: sin espacios, en minúsculas y sin /32 ni /128. */
export function normalizeIpEntry(raw: string): string {
  const e = parseIpEntry(raw);
  if (!e) return raw.trim();
  return e.prefix === maxPrefix(e.family) ? e.address : `${e.address}/${e.prefix}`;
}

function blockListOf(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const e of entries.map(parseIpEntry)) {
    if (!e) continue;
    if (e.prefix === maxPrefix(e.family)) list.addAddress(e.address, ipType(e.family));
    else list.addSubnet(e.address, e.prefix, ipType(e.family));
  }
  return list;
}

/** ¿Esta IP (entera) está en la lista? Una IP desconocida (null) nunca. */
export function ipInList(ip: string | null, entries: readonly string[]): boolean {
  const address = normalizeIp(ip);
  if (!address || entries.length === 0) return false;
  return blockListOf(entries).check(address, ipType(isIP(address) as 4 | 6));
}

/** ¿La entrada de una clave cabe entera dentro de alguna de las del socio? */
export function ipEntryInside(raw: string, partnerEntries: readonly string[]): boolean {
  const e = parseIpEntry(raw);
  if (!e) return false;
  return partnerEntries.some((p) => {
    const outer = parseIpEntry(p);
    return outer !== null && outer.family === e.family && outer.prefix <= e.prefix && ipInList(e.address, [p]);
  });
}
