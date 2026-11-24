import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { createHash, createPublicKey } from "node:crypto";

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export interface JwtSigner {
  readonly jwks: () => Promise<{
    readonly keys: readonly Readonly<Record<string, unknown>>[];
  }>;
  readonly sign: (claims: object) => Promise<string>;
}

export function makeKmsJwtSigner(input: {
  readonly keyId: string;
  readonly kid: string;
  readonly kms?: KMSClient;
}): JwtSigner {
  const kms = input.kms ?? new KMSClient({});
  let publicJwk: Readonly<Record<string, unknown>> | undefined;
  return {
    jwks: async () => {
      if (!publicJwk) {
        const result = await kms.send(new GetPublicKeyCommand({ KeyId: input.keyId }));
        if (!result.PublicKey) throw new Error("KMS signing key has no public key.");
        publicJwk = {
          ...(createPublicKey({
            format: "der",
            key: Buffer.from(result.PublicKey),
            type: "spki",
          }).export({ format: "jwk" }) as Readonly<Record<string, unknown>>),
          alg: "RS256",
          kid: input.kid,
          use: "sig",
        };
      }
      return { keys: [publicJwk] };
    },
    sign: async (claims) => {
      const signingInput = `${encode({ alg: "RS256", kid: input.kid, typ: "JWT" })}.${encode(claims)}`;
      const digest = createHash("sha256").update(signingInput, "ascii").digest();
      const result = await kms.send(
        new SignCommand({
          KeyId: input.keyId,
          Message: digest,
          MessageType: "DIGEST",
          SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
        }),
      );
      if (!result.Signature) throw new Error("KMS returned no JWT signature.");
      return `${signingInput}.${Buffer.from(result.Signature).toString("base64url")}`;
    },
  };
}
