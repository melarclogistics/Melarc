import { isIP } from 'node:net';

/** At most this many hops are named. An engineering bound: a longer list is a topology nobody can reason about. */
const MAX_HOPS = 16;

/** One trusted hop: an address, or an address with a prefix length from 1 up to the address family's width. */
function isHop(text: string): boolean {
  const [address = '', prefix, ...extra] = text.split('/');
  const family = isIP(address);
  if (family === 0 || extra.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^[1-9]\d{0,2}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * `HTTP_TRUST_PROXY`: `off`, or the trusted hops by address (DEPLOYMENT_AND_ENVIRONMENTS.md §12.2). Returns the empty list
 * for `off`, the hops otherwise, and undefined for anything else. A deployment that fronts the API names which hops it trusts;
 * trust is never switched on for every sender, so a count, `true`, a wildcard, a name Express would expand and a range that
 * covers every address are refused, and so is a host name, which would be resolved at start and not be an address at all.
 */
export function parseTrustProxy(text: string): readonly string[] | undefined {
  if (text === 'off') return [];
  const hops = text.split(',');
  if (hops.length > MAX_HOPS || !hops.every(isHop)) return undefined;
  return hops;
}
