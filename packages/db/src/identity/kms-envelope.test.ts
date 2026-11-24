import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import { expect, test } from "bun:test";
import { makeKmsEnvelopeAdapter } from "./kms-envelope.ts";

test("envelope operations wipe the KMS-owned plaintext data-key arrays", async () => {
  const generatedPlaintext = new Uint8Array(32).fill(7);
  const decryptedPlaintext = new Uint8Array(32).fill(7);
  const kms = {
    send: async (command: unknown) => {
      if (command instanceof GenerateDataKeyCommand) {
        return {
          CiphertextBlob: new Uint8Array([1, 2, 3]),
          Plaintext: generatedPlaintext,
        };
      }
      if (command instanceof DecryptCommand) return { Plaintext: decryptedPlaintext };
      throw new Error("Unexpected KMS command.");
    },
  } as unknown as KMSClient;
  const adapter = makeKmsEnvelopeAdapter({
    keyId: "test-key",
    kms,
    random: { bytes: (length) => new Uint8Array(length).fill(3) },
    stage: "test",
  });

  const envelope = await adapter.encrypt({ secret: "value" }, { purpose: "test" });
  expect([...generatedPlaintext]).toEqual(Array.from({ length: 32 }, () => 0));
  expect(adapter.decrypt(envelope, { purpose: "test" })).resolves.toEqual({
    secret: "value",
  });
  expect([...decryptedPlaintext]).toEqual(Array.from({ length: 32 }, () => 0));
});
