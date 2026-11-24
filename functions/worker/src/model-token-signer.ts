import { SignCommand, type KMSClient } from "@aws-sdk/client-kms";
import {
  MODEL_GATEWAY_TOKEN_AUDIENCE,
  MODEL_GATEWAY_TOKEN_ISSUER,
  signModelGatewayToken,
  type ModelGatewayTokenClaims,
  type ModelGatewayTokenSigningRequest,
  type ModelTokenResponse,
} from "@deployments-ai/model-gateway";

/** Signs model gateway tokens with one asymmetric key; `keyId` becomes the JWT `kid`. */
export interface ModelTokenSigner {
  readonly keyId: string;
  /** Returns a DER ECDSA P-256 signature over the token's signing input. */
  readonly sign: (request: ModelGatewayTokenSigningRequest) => Promise<Uint8Array>;
}

/** Signs with a KMS `ECC_NIST_P256` key; the key ARN is the token's `kid`. */
export function kmsModelTokenSigner(
  client: Pick<KMSClient, "send">,
  keyArn: string,
): ModelTokenSigner {
  return {
    keyId: keyArn,
    async sign({ digest }) {
      const result = await client.send(
        new SignCommand({
          KeyId: keyArn,
          Message: digest,
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        }),
      );
      if (!result.Signature) throw new Error("KMS Sign returned no signature.");
      return result.Signature;
    },
  };
}

type RegisteredClaim = "aud" | "exp" | "iat" | "iss" | "jti";
type WithoutRegisteredClaims<Claims> = Claims extends unknown
  ? Omit<Claims, RegisteredClaim>
  : never;

/** Token claims the issuer decides; the registered claims are added when the token is minted. */
export type UnsignedModelGatewayTokenClaims = WithoutRegisteredClaims<ModelGatewayTokenClaims>;

/** Adds the registered claims (`exp = iat + ttlSeconds`), signs, and returns the issuer response. */
export async function mintModelGatewayToken(
  dependencies: {
    readonly generateTokenId: () => string;
    readonly now: () => Date;
    readonly signer: ModelTokenSigner;
  },
  claims: UnsignedModelGatewayTokenClaims,
  ttlSeconds: number,
): Promise<ModelTokenResponse> {
  const iat = Math.floor(dependencies.now().getTime() / 1000);
  const exp = iat + ttlSeconds;
  const token = await signModelGatewayToken({
    claims: {
      ...claims,
      aud: MODEL_GATEWAY_TOKEN_AUDIENCE,
      exp,
      iat,
      iss: MODEL_GATEWAY_TOKEN_ISSUER,
      jti: dependencies.generateTokenId(),
    } as ModelGatewayTokenClaims,
    keyId: dependencies.signer.keyId,
    sign: dependencies.signer.sign,
  });
  return { expiresAt: exp, models: claims.models, ok: true, token };
}
