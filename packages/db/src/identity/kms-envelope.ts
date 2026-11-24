import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ProtectedEnvelope } from "./record-builders.ts";

/** Byte source for envelope IVs; structurally compatible with `@deployments-ai/identity` sources. */
export interface EnvelopeRandomSource {
  readonly bytes: (length: number) => Uint8Array;
}

const systemRandom: EnvelopeRandomSource = { bytes: (length) => randomBytes(length) };

function encryptionContext(stage: string, context: Readonly<Record<string, string>>) {
  return Object.fromEntries(
    Object.entries({ stage, ...context }).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function contextHash(context: Readonly<Record<string, string>>) {
  return createHash("sha256").update(JSON.stringify(context), "utf8").digest("hex");
}

export interface EnvelopeAdapter {
  readonly decrypt: <Value>(
    envelope: ProtectedEnvelope,
    binding: Readonly<Record<string, string>>,
  ) => Promise<Value>;
  readonly encrypt: (
    value: unknown,
    binding: Readonly<Record<string, string>>,
  ) => Promise<ProtectedEnvelope>;
}

/**
 * AES-256-GCM envelope encryption under a KMS data key bound to the stage plus a caller binding.
 * The binding is both the KMS encryption context and the GCM additional authenticated data.
 */
export function makeKmsEnvelopeAdapter(input: {
  readonly keyId: string;
  readonly kms?: KMSClient;
  readonly random?: EnvelopeRandomSource;
  readonly stage: string;
}): EnvelopeAdapter {
  const kms = input.kms ?? new KMSClient({});
  const random = input.random ?? systemRandom;
  return {
    decrypt: async <Value>(
      envelope: ProtectedEnvelope,
      binding: Readonly<Record<string, string>>,
    ): Promise<Value> => {
      const context = encryptionContext(input.stage, binding);
      if (envelope.encryptionContextHash !== contextHash(context)) {
        throw new Error("Protected envelope context mismatch.");
      }
      const key = await kms.send(
        new DecryptCommand({
          CiphertextBlob: Buffer.from(envelope.encryptedDataKey, "base64"),
          EncryptionContext: context,
          KeyId: input.keyId,
        }),
      );
      if (!key.Plaintext) throw new Error("KMS returned no plaintext data key.");
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key.Plaintext,
          Buffer.from(envelope.iv, "base64"),
        );
        decipher.setAAD(Buffer.from(JSON.stringify(context), "utf8"));
        decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64"));
        return JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        ) as Value;
      } finally {
        key.Plaintext.fill(0);
      }
    },
    encrypt: async (
      value: unknown,
      binding: Readonly<Record<string, string>>,
    ): Promise<ProtectedEnvelope> => {
      const context = encryptionContext(input.stage, binding);
      const generated = await kms.send(
        new GenerateDataKeyCommand({
          EncryptionContext: context,
          KeyId: input.keyId,
          KeySpec: "AES_256",
        }),
      );
      if (!generated.Plaintext || !generated.CiphertextBlob) {
        throw new Error("KMS returned incomplete data key material.");
      }
      const iv = Buffer.from(random.bytes(12));
      try {
        const cipher = createCipheriv("aes-256-gcm", generated.Plaintext, iv);
        cipher.setAAD(Buffer.from(JSON.stringify(context), "utf8"));
        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(value), "utf8"),
          cipher.final(),
        ]);
        return {
          algorithm: "AES-256-GCM",
          authenticationTag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
          encryptedDataKey: Buffer.from(generated.CiphertextBlob).toString("base64"),
          encryptionContextHash: contextHash(context),
          iv: iv.toString("base64"),
          schemaVersion: 1,
        };
      } finally {
        generated.Plaintext.fill(0);
      }
    },
  };
}
