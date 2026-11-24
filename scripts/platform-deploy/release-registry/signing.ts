import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GetPublicKeyCommand, type KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { decodeReleaseSignature, type ReleaseRecordSignature } from "./record.ts";

export interface ReleaseSigner {
  sign(message: Uint8Array): Promise<{ readonly keyId: string; readonly signature: Uint8Array }>;
  publicKey(): Promise<KeyObject>;
}

/**
 * KMS key spec `ECC_NIST_P256`: KMS signs the SHA-256 digest (`MessageType: "DIGEST"`), so the
 * record never leaves this process and its size is not bound by the 4 KiB raw-message limit.
 */
export function kmsReleaseSigner(input: {
  readonly client: Pick<KMSClient, "send">;
  readonly keyId: string;
}): ReleaseSigner {
  return {
    async sign(message) {
      const response = await input.client.send(
        new SignCommand({
          KeyId: input.keyId,
          Message: createHash("sha256").update(message).digest(),
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        }),
      );
      if (!response.KeyId || !response.Signature) {
        throw new Error(`KMS returned no signature for ${input.keyId}.`);
      }
      return { keyId: response.KeyId, signature: response.Signature };
    },
    async publicKey() {
      const response = await input.client.send(new GetPublicKeyCommand({ KeyId: input.keyId }));
      if (!response.PublicKey) throw new Error(`KMS returned no public key for ${input.keyId}.`);
      return createPublicKey({ format: "der", key: Buffer.from(response.PublicKey), type: "spki" });
    },
  };
}

export function verifyReleaseSignature(input: {
  readonly publicKey: KeyObject;
  readonly record: Uint8Array;
  readonly signature: ReleaseRecordSignature;
}) {
  return verify(
    "sha256",
    input.record,
    input.publicKey,
    Buffer.from(input.signature.signature, "base64"),
  );
}

export type SignatureStatus = "invalid" | "unsigned" | "verified";

export function signatureStatus(input: {
  readonly publicKey: KeyObject;
  readonly record: Uint8Array;
  readonly signature: Uint8Array | undefined;
}): SignatureStatus {
  if (!input.signature) return "unsigned";
  let signature: ReleaseRecordSignature;
  try {
    signature = decodeReleaseSignature(input.signature);
  } catch {
    return "invalid";
  }
  return verifyReleaseSignature({ publicKey: input.publicKey, record: input.record, signature })
    ? "verified"
    : "invalid";
}

export async function readSigningPublicKey(path: string) {
  try {
    return createPublicKey(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read the release signing public key ${path}.`, { cause: error });
  }
}
