/* eslint-disable no-await-in-loop -- Redirect and DNS validation must complete serially so every hop is checked before the next request. */
import { lookup as dnsLookup } from "node:dns/promises";

import { BlockList, isIP, type LookupFunction } from "node:net";

import type {
  IpFamily,
  NormalizePublicHttpsUrlOptions,
  PinnedLookupOptions,
  ResolvedAddress,
  ResolvedPublicHttpsTarget,
  ResolvePublicHttpsTargetOptions,
} from "./types.ts";
import { NetSecurityError } from "./types.ts";

const privateOrReservedIpv4AddressBlocks = new BlockList();

// Current IANA global-unicast allocation (2000::/3). Public IPv6 must live here;
// everything outside is unallocated/reserved and fail-closed (allow-public model).
const globalUnicastIpv6AddressBlocks = new BlockList();
// Special-purpose ranges inside (or historically near) global space that must not
// be treated as public destinations even when inside 2000::/3.
const specialPurposeIpv6AddressBlocks = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  privateOrReservedIpv4AddressBlocks.addSubnet(address, prefix, "ipv4");
}

globalUnicastIpv6AddressBlocks.addSubnet("2000::", 3, "ipv6");

for (const [address, prefix] of [
  // Unspecified / loopback / IPv4-mapped / translation (outside or edge of global)
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["::ffff:0:0", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  // Special-purpose inside 2000::/3
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  // ULA, link-local, deprecated site-local, multicast
  ["fc00::", 7],
  ["fe80::", 10],
  // Deprecated site-local (RFC 3879); not covered by fc00::/7 or fe80::/10.
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  specialPurposeIpv6AddressBlocks.addSubnet(address, prefix, "ipv6");
}

export function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.+$/u, "");
}

export function isLocalhostHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

/**
 * True when the address is a currently routable public destination.
 *
 * IPv4: not private/reserved (denylist of special ranges).
 * IPv6: must be in the current global-unicast allocation (2000::/3) and not in
 * any special-purpose range. Unallocated/reserved space outside 2000::/3 is
 * rejected rather than relying on an incomplete denylist.
 */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !privateOrReservedIpv4AddressBlocks.check(address, "ipv4");
  }
  if (family === 6) {
    if (!globalUnicastIpv6AddressBlocks.check(address, "ipv6")) return false;
    if (specialPurposeIpv6AddressBlocks.check(address, "ipv6")) return false;
    return true;
  }
  return false;
}

/**
 * True for private, reserved, special-purpose, or non-globally-routable IPs.
 * Invalid IP strings return false (callers should validate with isIP first).
 */
export function isPrivateOrReservedIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !isPublicIpAddress(address);
}

export function isBlockedPublicHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (isLocalhostHostname(normalized)) return true;
  if (
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home.arpa")
  ) {
    return true;
  }
  if (!normalized.includes(".") && isIP(normalized) === 0) return true;
  if (isIP(normalized) !== 0) return isPrivateOrReservedIpAddress(normalized);
  return false;
}

export function normalizePublicHttpsUrl(
  rawUrl: string,
  options: NormalizePublicHttpsUrlOptions = {},
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (cause) {
    throw new NetSecurityError("invalid-url", "URL must be a valid absolute URL.", { cause });
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (parsed.username || parsed.password) {
    throw new NetSecurityError("credentials", "URL must not include credentials.");
  }

  if (options.allowLocalTargets) {
    const isLocalTarget =
      isLocalhostHostname(hostname) &&
      (parsed.protocol === "http:" || parsed.protocol === "https:");
    if (isLocalTarget) return parsed.toString();
  }

  if (parsed.protocol !== "https:") {
    throw new NetSecurityError("non-https", "URL must use https.");
  }
  if (isBlockedPublicHostname(hostname)) {
    throw new NetSecurityError("non-public-host", "URL must target a public host.");
  }

  return parsed.toString();
}

export function normalizeResolvedAddress(
  entry: Readonly<{ address: string; family?: number }>,
): ResolvedAddress | undefined {
  const address = normalizeHostname(entry.address);
  const family = isIP(address);
  if (family !== 4 && family !== 6) return undefined;
  if (entry.family !== undefined && entry.family !== family) return undefined;
  return { address, family };
}

export async function defaultDnsLookup(hostname: string): Promise<readonly ResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family }]
      : [],
  );
}

export async function resolvePublicHttpsTarget(
  rawUrl: string,
  options: ResolvePublicHttpsTargetOptions = {},
): Promise<ResolvedPublicHttpsTarget> {
  // Enforce the same public-HTTPS URL policy as normalizePublicHttpsUrl so this
  // helper is safe when used standalone (scheme, credentials, blocked hosts).
  const url = normalizePublicHttpsUrl(
    rawUrl,
    options.allowLocalTargets ? { allowLocalTargets: true } : {},
  );
  const parsed = new URL(url);
  const hostname = normalizeHostname(parsed.hostname);

  // normalizePublicHttpsUrl already restricted localhost to explicit http(s).
  if (options.allowLocalTargets && isLocalhostHostname(hostname)) {
    return {
      addresses: [],
      localTarget: true,
      url,
    };
  }

  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isPrivateOrReservedIpAddress(hostname)) {
      throw new NetSecurityError("private-address", "Target must resolve to public addresses.");
    }
    return {
      addresses: [{ address: hostname, family: literalFamily }],
      localTarget: false,
      url,
    };
  }

  const lookup = options.dnsLookup ?? defaultDnsLookup;
  const rawAddresses = await lookup(hostname);
  if (rawAddresses.length === 0) {
    throw new NetSecurityError("empty-dns", "Host did not resolve to any addresses.");
  }

  // Fail closed: any malformed/mismatched resolver entry rejects the whole set
  // rather than silently accepting a partially-invalid mix.
  const addresses: ResolvedAddress[] = [];
  for (const entry of rawAddresses) {
    const normalized = normalizeResolvedAddress(entry);
    if (!normalized) {
      throw new NetSecurityError(
        "invalid-dns",
        "Host resolved to malformed or mismatched addresses.",
      );
    }
    addresses.push(normalized);
  }

  if (addresses.some((entry) => isPrivateOrReservedIpAddress(entry.address))) {
    throw new NetSecurityError("private-address", "Target must resolve to public addresses.");
  }

  return {
    addresses,
    localTarget: false,
    url,
  };
}

export function createPinnedLookup(
  addresses: readonly ResolvedAddress[],
  options: PinnedLookupOptions = {},
): LookupFunction {
  const emptyMessage = options.emptyMessage ?? "Target has no resolved addresses.";

  return ((
    _hostname: string,
    lookupOptions: { all?: boolean | undefined },
    callback: (
      error: NodeJS.ErrnoException | null,
      address:
        | string
        | readonly {
            readonly address: string;
            readonly family: IpFamily;
          }[],
      family?: IpFamily,
    ) => void,
  ) => {
    if (lookupOptions.all) {
      callback(
        null,
        addresses.map((entry) => ({ address: entry.address, family: entry.family })),
      );
      return;
    }

    const [first] = addresses;
    if (!first) {
      callback(Object.assign(new Error(emptyMessage), { code: "ENOTFOUND" }), "");
      return;
    }

    callback(null, first.address, first.family);
  }) as LookupFunction;
}
