import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { CREDENTIAL_VAULT_ALGORITHM, CredentialVaultError } from "./types.ts";

interface EncryptedDocument {
  readonly algorithm: typeof CREDENTIAL_VAULT_ALGORITHM;
  readonly authTag: string;
  readonly ciphertext: string;
  readonly encryptedDataKey: string;
  readonly iv: string;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly key: Buffer;
}

export class CredentialDataKeyCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 100,
  ) {}

  get(encryptedDataKey: string) {
    const entry = this.entries.get(encryptedDataKey);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) entry.key.fill(0);
      this.entries.delete(encryptedDataKey);
      return undefined;
    }
    this.entries.delete(encryptedDataKey);
    this.entries.set(encryptedDataKey, entry);
    return Buffer.from(entry.key);
  }

  set(encryptedDataKey: string, key: Buffer) {
    const existing = this.entries.get(encryptedDataKey);
    if (existing) existing.key.fill(0);
    this.entries.set(encryptedDataKey, {
      expiresAt: Date.now() + this.ttlMs,
      key: Buffer.from(key),
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      oldest[1].key.fill(0);
      this.entries.delete(oldest[0]);
    }
  }
}

export async function encryptCredentialDocument(args: {
  readonly context: Readonly<Record<string, string>>;
  readonly kmsClient: KMSClient;
  readonly kmsKeyArn: string;
  readonly plaintext: string;
}): Promise<EncryptedDocument> {
  const generated = await args.kmsClient.send(
    new GenerateDataKeyCommand({
      EncryptionContext: args.context,
      KeyId: args.kmsKeyArn,
      KeySpec: "AES_256",
    }),
  );
  if (!generated.Plaintext || !generated.CiphertextBlob) {
    throw new CredentialVaultError("crypto", "KMS did not return a complete data key.");
  }
  const key = Buffer.from(generated.Plaintext);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(args.context), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(args.plaintext, "utf8"), cipher.final()]);
    return {
      algorithm: CREDENTIAL_VAULT_ALGORITHM,
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      encryptedDataKey: Buffer.from(generated.CiphertextBlob).toString("base64"),
      iv: iv.toString("base64"),
    };
  } catch (cause) {
    throw new CredentialVaultError("crypto", "Credential encryption failed.", { cause });
  } finally {
    key.fill(0);
  }
}

export async function decryptCredentialDocument(
  args: EncryptedDocument & {
    readonly cache: CredentialDataKeyCache;
    readonly context: Readonly<Record<string, string>>;
    readonly kmsClient: KMSClient;
    readonly kmsKeyArn: string;
  },
) {
  let key = args.cache.get(args.encryptedDataKey);
  if (!key) {
    const decrypted = await args.kmsClient.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(args.encryptedDataKey, "base64"),
        EncryptionContext: args.context,
        KeyId: args.kmsKeyArn,
      }),
    );
    if (!decrypted.Plaintext) {
      throw new CredentialVaultError("crypto", "KMS did not return a plaintext data key.");
    }
    key = Buffer.from(decrypted.Plaintext);
    args.cache.set(args.encryptedDataKey, key);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(args.iv, "base64"));
    decipher.setAAD(Buffer.from(JSON.stringify(args.context), "utf8"));
    decipher.setAuthTag(Buffer.from(args.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(args.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new CredentialVaultError("crypto", "Credential decryption failed.", { cause });
  } finally {
    key.fill(0);
  }
}
