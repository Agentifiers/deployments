import { createHash, timingSafeEqual } from "node:crypto";
import { BlobReference } from "@deployments-ai/db";
export type MemoryBlobReference = typeof BlobReference.Type;
export type MemoryBlobDeleter = (reference: MemoryBlobReference) => Promise<void>;
export type MemoryBlobLoader = (reference: MemoryBlobReference) => Promise<Uint8Array | string>;

export class MemoryBlobIntegrityError extends TypeError {}

function normalizedSha256(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, "");
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : undefined;
}

export async function loadMemoryBlobText(args: {
  readonly label: string;
  readonly load: MemoryBlobLoader;
  readonly maxBytes: number;
  readonly reference: MemoryBlobReference;
}) {
  if (args.reference.byteSize > args.maxBytes) {
    throw new MemoryBlobIntegrityError(`${args.label} exceeds the maximum supported byte size.`);
  }
  const loaded = await args.load(args.reference);
  const bytes = typeof loaded === "string" ? new TextEncoder().encode(loaded) : loaded;
  if (bytes.byteLength !== args.reference.byteSize) {
    throw new MemoryBlobIntegrityError(
      `${args.label} byte size does not match its canonical reference.`,
    );
  }
  const expectedHash = normalizedSha256(args.reference.sha256);
  const actualHash = createHash("sha256").update(bytes).digest();
  if (!expectedHash || !timingSafeEqual(actualHash, Buffer.from(expectedHash, "hex"))) {
    throw new MemoryBlobIntegrityError(
      `${args.label} does not match its canonical reference hash.`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new MemoryBlobIntegrityError(`${args.label} must contain valid UTF-8 text.`, { cause });
  }
}
