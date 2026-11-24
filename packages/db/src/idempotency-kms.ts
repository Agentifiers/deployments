import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { IdempotencyResponseContext, IdempotencyResponseProtector } from "./idempotency.ts";

export interface KmsIdempotencyResponseProtectorDependencies {
  readonly kmsClient?: KMSClient;
  readonly kmsKeyArn: string;
}

function encryptionContext(context: IdempotencyResponseContext) {
  return {
    fingerprint: context.fingerprint,
    idempotencyKey: context.idempotencyKey,
    principalId: context.principalId,
  };
}

function responseDocument(value: unknown) {
  return JSON.stringify(value === undefined ? { kind: "undefined" } : { kind: "value", value });
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Protected idempotency response ${field} is invalid.`);
  }
  return value;
}

function decodeResponseDocument(value: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Protected idempotency response is invalid.");
  }
  const document = parsed as Readonly<Record<string, unknown>>;
  if (document.kind === "undefined") return undefined;
  if (document.kind !== "value" || !Object.hasOwn(document, "value")) {
    throw new TypeError("Protected idempotency response is invalid.");
  }
  return document.value;
}

export function makeKmsIdempotencyResponseProtector(
  dependencies: KmsIdempotencyResponseProtectorDependencies,
): IdempotencyResponseProtector {
  const kmsClient = dependencies.kmsClient ?? new KMSClient({});
  return {
    async prepare(context) {
      const kmsContext = encryptionContext(context);
      const generated = await kmsClient.send(
        new GenerateDataKeyCommand({
          EncryptionContext: kmsContext,
          KeyId: dependencies.kmsKeyArn,
          KeySpec: "AES_256",
        }),
      );
      if (!generated.Plaintext || !generated.CiphertextBlob) {
        throw new Error("KMS did not return a complete idempotency data key.");
      }
      const key = Buffer.from(generated.Plaintext);
      const encryptedDataKey = Buffer.from(generated.CiphertextBlob).toString("base64");
      return {
        dispose: () => key.fill(0),
        protect: async (value) => {
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          cipher.setAAD(Buffer.from(JSON.stringify(kmsContext), "utf8"));
          const ciphertext = Buffer.concat([
            cipher.update(responseDocument(value), "utf8"),
            cipher.final(),
          ]);
          return {
            algorithm: "AES-256-GCM",
            authTag: cipher.getAuthTag().toString("base64"),
            ciphertext: ciphertext.toString("base64"),
            encryptedDataKey,
            iv: iv.toString("base64"),
            kmsKeyArn: dependencies.kmsKeyArn,
          };
        },
      };
    },
    async unprotect(value, context) {
      const kmsContext = encryptionContext(context);
      const encryptedDataKey = requiredString(value.encryptedDataKey, "encryptedDataKey");
      const encryptedKmsKeyArn = requiredString(value.kmsKeyArn, "kmsKeyArn");
      if (value.algorithm !== "AES-256-GCM" || encryptedKmsKeyArn !== dependencies.kmsKeyArn) {
        throw new TypeError("Protected idempotency response encryption metadata is invalid.");
      }
      const decrypted = await kmsClient.send(
        new DecryptCommand({
          CiphertextBlob: Buffer.from(encryptedDataKey, "base64"),
          EncryptionContext: kmsContext,
          KeyId: dependencies.kmsKeyArn,
        }),
      );
      if (!decrypted.Plaintext) {
        throw new Error("KMS did not return an idempotency data key.");
      }
      const key = Buffer.from(decrypted.Plaintext);
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(requiredString(value.iv, "iv"), "base64"),
        );
        decipher.setAAD(Buffer.from(JSON.stringify(kmsContext), "utf8"));
        decipher.setAuthTag(Buffer.from(requiredString(value.authTag, "authTag"), "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(requiredString(value.ciphertext, "ciphertext"), "base64")),
          decipher.final(),
        ]).toString("utf8");
        return decodeResponseDocument(plaintext);
      } finally {
        key.fill(0);
      }
    },
  };
}
