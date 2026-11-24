import { createHash } from "node:crypto";

export function ordinalCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Canonical JSON does not support undefined, functions, or symbols.");
    }
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => ordinalCompare(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Bytes(value: string | Uint8Array): Uint8Array {
  return createHash("sha256").update(value).digest();
}

export function hashChain(values: readonly unknown[]) {
  let previousHash = "0".repeat(64);
  const entries = values.map((value) => {
    const entryHash = sha256(`${previousHash}\n${canonicalJson(value)}`);
    const result = { entryHash, previousHash, value };
    previousHash = entryHash;
    return result;
  });
  return { entries, rootHash: previousHash };
}
