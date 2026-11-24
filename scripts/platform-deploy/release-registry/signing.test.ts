import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import { KMSClient } from "@aws-sdk/client-kms";
import type { ReleaseRecordSignature } from "./record.ts";
import { kmsReleaseSigner, verifyReleaseSignature } from "./signing.ts";

const record = new TextEncoder().encode('{"version":1}\n');
const keyArn = "arn:aws:kms:us-east-2:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab";

interface CapturedRequest {
  readonly body: unknown;
  readonly target: string | undefined;
}

function localKms(respond: (target: string | undefined) => unknown) {
  const requests: CapturedRequest[] = [];
  const client = new KMSClient({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    region: "us-east-2",
    requestHandler: {
      async handle(request: { readonly body: unknown; readonly headers: Record<string, string> }) {
        const target = request.headers["x-amz-target"];
        requests.push({ body: JSON.parse(String(request.body)), target });
        return {
          response: {
            body: Readable.from([Buffer.from(JSON.stringify(respond(target)))]),
            headers: { "content-type": "application/x-amz-json-1.1" },
            statusCode: 200,
          },
        };
      },
    },
  });
  return { client, requests };
}

describe("KMS release signer", () => {
  test("signs the record's SHA-256 digest and returns a signature that verifies over the record", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const { client, requests } = localKms((target) =>
      target === "TrentService.Sign"
        ? {
            KeyId: keyArn,
            Signature: sign("sha256", record, privateKey).toString("base64"),
            SigningAlgorithm: "ECDSA_SHA_256",
          }
        : {
            KeyId: keyArn,
            PublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          },
    );
    const signer = kmsReleaseSigner({ client, keyId: "alias/platform-release-signing" });

    const signed = await signer.sign(record);

    expect(requests).toEqual([
      {
        body: {
          KeyId: "alias/platform-release-signing",
          Message: "UCCNeDUKehYN7FmoLfFJm2yn2jPlTF6xHJfjQhGOaLs=",
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        },
        target: "TrentService.Sign",
      },
    ]);
    expect(signed.keyId).toBe(keyArn);
    const document: ReleaseRecordSignature = {
      algorithm: "ECDSA_SHA_256",
      keyId: signed.keyId,
      signature: Buffer.from(signed.signature).toString("base64"),
      version: 1,
    };
    const kmsPublicKey = await signer.publicKey();
    expect(verifyReleaseSignature({ publicKey: kmsPublicKey, record, signature: document })).toBe(
      true,
    );
    expect(
      verifyReleaseSignature({
        publicKey: kmsPublicKey,
        record: new TextEncoder().encode('{"version":2}\n'),
        signature: document,
      }),
    ).toBe(false);
  });
});
