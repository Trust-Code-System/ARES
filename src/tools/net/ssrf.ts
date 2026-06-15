/**
 * SSRF guard for outbound fetches.
 *
 * An autonomous agent that fetches model-chosen URLs is a classic server-side
 * request forgery risk: a crafted URL (or a public hostname that resolves to a
 * private address, or a redirect into one) can reach the loopback interface, the
 * cloud metadata endpoint (169.254.169.254), or the internal network.
 *
 * Defenses here:
 *   - Block literal IPs in private/loopback/link-local/CGNAT/multicast/reserved
 *     ranges (IPv4 and IPv6, including IPv4-mapped IPv6).
 *   - Resolve hostnames via DNS and block if ANY resolved address is blocked.
 *   - The caller re-runs this guard on every redirect hop (see webFetch), so a
 *     302 into `http://169.254.169.254/` is rejected too.
 *
 * The IP-range predicates are pure and exported so they're unit-testable without
 * the network; DNS resolution is injectable for the same reason.
 *
 * Residual risk: a TOCTOU DNS-rebind between this lookup and the socket connect
 * is not fully closed (that needs pinning the connection to the validated IP,
 * which the platform `fetch` doesn't expose). Acceptable for a single-user
 * assistant; noted so it isn't mistaken for airtight.
 */

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export class SsrfError extends Error {
  constructor(host: string, detail: string) {
    super(`Blocked by SSRF guard: ${host} ${detail}.`);
    this.name = 'SsrfError';
  }
}

/** Parse a dotted-quad IPv4 string to a 32-bit unsigned int, or null if malformed. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n >>> 0;
}

function inV4Range(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (b & mask);
}

/** IPv4 ranges that must never be reachable by an agent fetch. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved / 255.255.255.255 broadcast
];

export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → fail closed
  return BLOCKED_V4.some(([base, bits]) => inV4Range(n, base, bits));
}

/** Expand a (valid) IPv6 string into its eight 16-bit groups, or null if unparseable. */
function expandIpv6(addr: string): number[] | null {
  if (isIP(addr) !== 6) return null;
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [
    ...head,
    ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

export function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]!; // drop any zone id
  // IPv4-mapped / -embedded (::ffff:a.b.c.d, ::a.b.c.d) → judge the embedded v4.
  const embedded = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) return isBlockedIpv4(embedded[1]!);

  const g = expandIpv6(addr);
  if (!g) return true; // fail closed
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True if a literal IP string (any family) is in a blocked range. */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) return isBlockedIpv6(ip);
  return true; // not a literal IP → fail closed (callers pass literals only)
}

/** Injectable resolver so the guard is testable without real DNS. */
export type AddressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: AddressResolver = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Throw {@link SsrfError} unless `url`'s host is (or resolves entirely to) public
 * addresses. Literal IPs are checked directly; hostnames are resolved and every
 * returned address must pass.
 */
export async function assertPublicUrl(url: URL, resolver: AddressResolver = defaultResolver): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const fam = isIP(host);
  if (fam === 4 || fam === 6) {
    if (isBlockedIp(host)) throw new SsrfError(host, 'is a private/reserved address');
    return;
  }

  const addresses = await resolver(host);
  if (addresses.length === 0) throw new SsrfError(host, 'has no DNS records');
  for (const a of addresses) {
    const blocked = a.family === 6 ? isBlockedIpv6(a.address) : isBlockedIpv4(a.address);
    if (blocked) throw new SsrfError(host, `resolves to blocked address ${a.address}`);
  }
}
