import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

export interface OpaqueCursorCodec {
  open(ciphertext: string): Promise<string>;
  seal(plaintext: string): Promise<string>;
}

export interface KmsOpaqueCursorCodecOptions {
  readonly encryptionContext: Readonly<Record<string, string>>;
  readonly kmsClient?: KMSClient;
  readonly kmsKeyArn: string;
}

export function makeKmsOpaqueCursorCodec(options: KmsOpaqueCursorCodecOptions): OpaqueCursorCodec {
  const kmsClient = options.kmsClient ?? new KMSClient({});
  return {
    async open(ciphertext) {
      const result = await kmsClient.send(
        new DecryptCommand({
          CiphertextBlob: Buffer.from(ciphertext, "base64url"),
          EncryptionContext: options.encryptionContext,
          KeyId: options.kmsKeyArn,
        }),
      );
      if (!result.Plaintext) throw new Error("KMS returned no cursor plaintext.");
      return Buffer.from(result.Plaintext).toString("utf8");
    },
    async seal(plaintext) {
      const result = await kmsClient.send(
        new EncryptCommand({
          EncryptionContext: options.encryptionContext,
          KeyId: options.kmsKeyArn,
          Plaintext: Buffer.from(plaintext, "utf8"),
        }),
      );
      if (!result.CiphertextBlob) throw new Error("KMS returned no encrypted cursor.");
      return Buffer.from(result.CiphertextBlob).toString("base64url");
    },
  };
}
