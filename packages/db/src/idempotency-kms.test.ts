import { describe, expect, test } from "bun:test";
import type { KMSClient } from "@aws-sdk/client-kms";
import { makeKmsIdempotencyResponseProtector } from "./idempotency-kms.ts";

const context = {
  fingerprint: "request-fingerprint",
  idempotencyKey: "agent-api:hashed-key",
  principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
};

function kmsClient() {
  const plaintextKey = Buffer.alloc(32, 7);
  return {
    send: async (command: object) => {
      if (command.constructor.name === "GenerateDataKeyCommand") {
        return {
          CiphertextBlob: Buffer.from("encrypted-data-key"),
          Plaintext: Buffer.from(plaintextKey),
        };
      }
      if (command.constructor.name === "DecryptCommand") {
        return { Plaintext: Buffer.from(plaintextKey) };
      }
      throw new Error(`Unexpected KMS command ${command.constructor.name}.`);
    },
  } as unknown as KMSClient;
}

describe("KMS idempotency response protection", () => {
  test("round trips issued secrets without persisting plaintext", async () => {
    const protector = makeKmsIdempotencyResponseProtector({
      kmsClient: kmsClient(),
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/idempotency",
    });
    const response = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      secret: "dpl_plaintext_secret",
      secretVisibleOnce: true,
    };

    const prepared = await protector.prepare(context);
    const protectedResponse = await prepared.protect(response);
    prepared.dispose();

    expect(JSON.stringify(protectedResponse)).not.toContain(response.secret);
    expect(await protector.unprotect(protectedResponse, context)).toEqual(response);
    expect(
      protector.unprotect(protectedResponse, {
        ...context,
        principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      }),
    ).rejects.toThrow();
  });
});
