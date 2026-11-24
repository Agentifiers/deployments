export const EMAIL_END_USER_ID_PREFIX = "channel:email:-:";

export function emailEndUserId(address: string): string {
  return `${EMAIL_END_USER_ID_PREFIX}${encodeURIComponent(address.trim().toLowerCase())}`;
}

export function emailAddressOfEndUserId(endUserId: string): string | undefined {
  if (!endUserId.startsWith(EMAIL_END_USER_ID_PREFIX)) return undefined;
  let address: string;
  try {
    address = decodeURIComponent(endUserId.slice(EMAIL_END_USER_ID_PREFIX.length));
  } catch {
    return undefined;
  }
  const canonical = address.trim().toLowerCase();
  return canonical.length > 0 ? canonical : undefined;
}

export function correspondentAddresses(
  addresses: readonly string[],
  exclude: readonly string[] = [],
): readonly string[] {
  const excluded = new Set(exclude.map((address) => address.trim().toLowerCase()));
  return [
    ...new Set(
      addresses
        .map((address) => address.trim().toLowerCase())
        .filter((address) => address.length > 0 && !excluded.has(address)),
    ),
  ].sort();
}
