const ADDRESS = /^[^\s@]+@[^\s@]+$/u;
const MAX_ADDRESS_LENGTH = 320;

export type AddressList =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly message: string };

export function parseAddresses(text: string, max: number): AddressList {
  const addresses = [
    ...new Set(
      text
        .split(/[\s,;]+/u)
        .filter((entry) => entry !== "")
        .map((entry) => entry.toLowerCase()),
    ),
  ];
  const invalid = addresses.find(
    (address) => address.length > MAX_ADDRESS_LENGTH || !ADDRESS.test(address),
  );
  if (invalid !== undefined) return { message: `${invalid} is not an email address.`, ok: false };
  if (addresses.length > max) {
    return { message: `At most ${max} addresses are allowed.`, ok: false };
  }
  return { addresses, ok: true };
}

export const DOMAIN_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
