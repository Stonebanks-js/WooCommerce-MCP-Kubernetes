import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

export type AddressClass = 'loopback' | 'link_local' | 'unspecified' | 'multicast' | 'reserved' | 'private' | 'public';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface SsrfOptions {
  allowPrivate: boolean;
  allowedSuffixes: string[];
  /** Injectable for tests; defaults to `dns.promises.lookup(host, { all: true })`. */
  lookup?: (host: string) => Promise<ResolvedAddress[]>;
}

export class UpstreamUrlError extends Error {
  override readonly name = 'UpstreamUrlError';
}

function classifyV4(ip: string): AddressClass {
  const o = ip.split('.').map(Number);
  const [a = 0, b = 0] = o;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
    return 'private';
  }
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

/** Expands `::` and returns the eight 16-bit groups, or null when malformed. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    // embedded IPv4 tail, e.g. ::ffff:10.0.0.1
    const v4 = s.slice(lastColon + 1).split('.').map(Number);
    if (v4.length !== 4) return null;
    const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    s = `${s.slice(0, lastColon)}:${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail].map((g) => parseInt(g || '0', 16));
  return groups.some((g) => Number.isNaN(g)) ? null : groups;
}

function classifyV6(ip: string): AddressClass {
  const g = v6Groups(ip);
  if (!g) return 'reserved';
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return classifyV4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`); // IPv4-mapped
    if (g5 === 0 && g6 === 0) {
      if (g7 === 0) return 'unspecified';
      if (g7 === 1) return 'loopback';
    }
  }
  if ((g0 & 0xffc0) === 0xfe80) return 'link_local';
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // ULA fc00::/7
  if ((g0 & 0xff00) === 0xff00) return 'multicast';
  return 'public';
}

export function classifyAddress(ip: string): AddressClass {
  const v = isIP(ip);
  if (v === 4) return classifyV4(ip);
  if (v === 6) return classifyV6(ip);
  return 'reserved';
}

const defaultLookup = async (host: string): Promise<ResolvedAddress[]> => dns.lookup(host, { all: true });

/**
 * Rejects non-http(s) URLs, URLs with credentials, `localhost`, and any address that is
 * unspecified, multicast, reserved or link-local (incl. 169.254.169.254). Loopback and
 * RFC1918/ULA/CGNAT addresses are allowed only with `allowPrivate`; private ranges are also allowed
 * when the hostname ends with one of `allowedSuffixes` (in-cluster names). A hostname that cannot
 * be resolved right now passes the address checks (the probe will report it unreachable) and is
 * checked again at connect time.
 */
export async function validateUpstreamUrl(raw: string, opts: SsrfOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpstreamUrlError('URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UpstreamUrlError('URL must use http or https');
  if (url.username || url.password) throw new UpstreamUrlError('URL must not contain credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new UpstreamUrlError('URL has no host');
  if ((host === 'localhost' || host.endsWith('.localhost')) && !opts.allowPrivate) {
    throw new UpstreamUrlError('localhost upstreams are not allowed');
  }
  const suffixOk = opts.allowedSuffixes.some((s) => s && host.endsWith(s.toLowerCase()));

  let addresses: ResolvedAddress[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await (opts.lookup ?? defaultLookup)(host);
    } catch {
      return url; // unresolvable now: hostname-level checks passed; re-validated at connect time
    }
  }
  for (const { address } of addresses) {
    const cls = classifyAddress(address);
    const allowed =
      cls === 'public' ||
      (cls === 'loopback' && opts.allowPrivate) ||
      (cls === 'private' && (opts.allowPrivate || suffixOk));
    if (!allowed) throw new UpstreamUrlError(`address ${address} (${cls.replace('_', '-')}) is not allowed for upstreams`);
  }
  return url;
}
