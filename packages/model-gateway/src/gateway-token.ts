import { createHash, type KeyObject, verify } from "node:crypto";
import { isModelCredentialProvider, type ModelFundingClaim } from "./model-funding.ts";

/** Audience of every model gateway token. */
export const MODEL_GATEWAY_TOKEN_AUDIENCE = "model-gateway";
/** Issuer of every model gateway token. */
export const MODEL_GATEWAY_TOKEN_ISSUER = "deployments-ai-model-token-issuer";
/** Run tokens live ten minutes; the run's lease is rechecked by the gateway on every request. */
export const MODEL_GATEWAY_RUN_TOKEN_TTL_SECONDS = 600;
/** Service tokens live fifteen minutes. */
export const MODEL_GATEWAY_SERVICE_TOKEN_TTL_SECONDS = 900;
/** The gateway rejects any token whose `exp - iat` exceeds this. */
export const MODEL_GATEWAY_TOKEN_MAX_LIFETIME_SECONDS = 900;
/** Clock skew tolerated on `iat` and `exp`. */
export const MODEL_GATEWAY_TOKEN_CLOCK_SKEW_SECONDS = 30;
/** Maximum number of models one token may carry. */
export const MODEL_GATEWAY_TOKEN_MAX_MODELS = 64;

const ES256_SIGNATURE_BYTES = 64;
const MAX_TOKEN_LENGTH = 16_384;

interface ModelGatewayTokenBaseClaims {
  readonly aud: typeof MODEL_GATEWAY_TOKEN_AUDIENCE;
  readonly exp: number;
  readonly iat: number;
  /** Providers the token's organization pays for with its own key; absent means operator-funded. */
  readonly funding?: ModelFundingClaim;
  readonly iss: typeof MODEL_GATEWAY_TOKEN_ISSUER;
  readonly jti: string;
  /** Canonical platform model ids the bearer may call, resolved when the token was minted. */
  readonly models: readonly string[];
  readonly sub: string;
}

/** Tenant context a service token may carry for attribution; the issuing service vouches for it. */
export interface ModelGatewayServiceTokenContext {
  readonly agentDefinitionId?: string;
  readonly environmentId?: string;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly workspaceId?: string;
}

/** A token bound to one claimed agent run: valid only while the run's thread lease is held. */
export interface ModelGatewayRunTokenClaims extends ModelGatewayTokenBaseClaims {
  readonly agentDefinitionId?: string;
  readonly agentDeploymentId?: string;
  readonly agentReleaseId?: string;
  readonly environmentId: string;
  readonly executionBindingId?: string;
  readonly kind: "run";
  /** The run's `claimedBy` owner token, mirrored on the thread execution lease. */
  readonly leaseOwner: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly workspaceId?: string;
}

/** A token for a platform service that calls models outside a claimed run. */
export interface ModelGatewayServiceTokenClaims
  extends ModelGatewayTokenBaseClaims, ModelGatewayServiceTokenContext {
  readonly kind: "service";
  readonly service: string;
}

export type ModelGatewayTokenClaims = ModelGatewayRunTokenClaims | ModelGatewayServiceTokenClaims;

type UnverifiedClaims<Claims extends ModelGatewayTokenBaseClaims> = Omit<Claims, "aud" | "iss"> & {
  readonly aud: string;
  readonly iss: string;
};

/** Well-formed claims whose issuer and audience {@link verifyModelGatewayToken} has not checked. */
export type UnverifiedModelGatewayTokenClaims =
  | UnverifiedClaims<ModelGatewayRunTokenClaims>
  | UnverifiedClaims<ModelGatewayServiceTokenClaims>;

export type ModelGatewayTokenRejection =
  | "bad_signature"
  | "expired"
  | "invalid_claims"
  | "lifetime_too_long"
  | "malformed"
  | "not_yet_valid"
  | "unknown_key"
  | "unsupported_algorithm"
  | "wrong_audience"
  | "wrong_issuer";

export type ModelGatewayTokenVerification =
  | { readonly claims: ModelGatewayTokenClaims; readonly ok: true }
  | { readonly message: string; readonly ok: false; readonly reason: ModelGatewayTokenRejection };

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 512;
}

function optionalNonEmptyString(value: unknown) {
  return value === undefined || nonEmptyString(value);
}

function isModelFundingClaim(value: unknown): value is ModelFundingClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([provider, ref]) => {
    if (!isModelCredentialProvider(provider) || !ref || typeof ref !== "object") return false;
    const { credentialId, keyVersion } = ref as Record<string, unknown>;
    return (
      nonEmptyString(credentialId) && Number.isSafeInteger(keyVersion) && Number(keyVersion) > 0
    );
  });
}

function hasValidBaseClaims(claims: Readonly<Record<string, unknown>>) {
  const models = claims.models;
  return (
    Number.isSafeInteger(claims.exp) &&
    Number.isSafeInteger(claims.iat) &&
    nonEmptyString(claims.jti) &&
    nonEmptyString(claims.sub) &&
    nonEmptyString(claims.iss) &&
    nonEmptyString(claims.aud) &&
    Array.isArray(models) &&
    models.length <= MODEL_GATEWAY_TOKEN_MAX_MODELS &&
    models.every(nonEmptyString) &&
    [
      "agentDefinitionId",
      "environmentId",
      "organizationId",
      "projectId",
      "runId",
      "workspaceId",
    ].every((field) => optionalNonEmptyString(claims[field])) &&
    (claims.funding === undefined ||
      (isModelFundingClaim(claims.funding) && nonEmptyString(claims.organizationId)))
  );
}

function isRunTokenClaims(
  claims: Readonly<Record<string, unknown>>,
): claims is UnverifiedClaims<ModelGatewayRunTokenClaims> {
  return (
    claims.kind === "run" &&
    hasValidBaseClaims(claims) &&
    nonEmptyString(claims.organizationId) &&
    nonEmptyString(claims.projectId) &&
    nonEmptyString(claims.environmentId) &&
    nonEmptyString(claims.runId) &&
    nonEmptyString(claims.threadId) &&
    nonEmptyString(claims.leaseOwner) &&
    ["agentDeploymentId", "agentReleaseId", "executionBindingId"].every((field) =>
      optionalNonEmptyString(claims[field]),
    ) &&
    claims.sub === `run:${claims.runId}`
  );
}

function isServiceTokenClaims(
  claims: Readonly<Record<string, unknown>>,
): claims is UnverifiedClaims<ModelGatewayServiceTokenClaims> {
  return (
    claims.kind === "service" &&
    hasValidBaseClaims(claims) &&
    nonEmptyString(claims.service) &&
    claims.sub === `service:${claims.service}`
  );
}

/**
 * Validates the shape of decoded token claims. Registered claims are checked by
 * {@link verifyModelGatewayToken}; this rejects anything a well-formed token could not carry.
 */
export function parseModelGatewayTokenClaims(
  value: unknown,
): UnverifiedModelGatewayTokenClaims | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const claims = value as Record<string, unknown>;
  return isRunTokenClaims(claims) || isServiceTokenClaims(claims) ? claims : undefined;
}

/**
 * Converts a DER-encoded ECDSA signature (what KMS `Sign` returns) into the fixed-width `r || s`
 * form JWS ES256 requires.
 */
export function derEcdsaSignatureToJose(der: Uint8Array, integerBytes = 32): Uint8Array {
  const bytes = Buffer.from(der);
  let offset = 0;
  const readLength = () => {
    const first = bytes[offset++];
    if (first === undefined) throw new Error("Truncated DER signature.");
    if (first < 0x80) return first;
    const count = first & 0x7f;
    if (count === 0 || count > 2) throw new Error("Unsupported DER length.");
    let length = 0;
    for (let index = 0; index < count; index += 1) {
      const next = bytes[offset++];
      if (next === undefined) throw new Error("Truncated DER signature.");
      length = (length << 8) | next;
    }
    return length;
  };
  const readInteger = () => {
    if (bytes[offset++] !== 0x02) throw new Error("DER signature integer expected.");
    const length = readLength();
    let value = bytes.subarray(offset, offset + length);
    offset += length;
    if (value.length !== length) throw new Error("Truncated DER signature.");
    while (value.length > integerBytes && value[0] === 0) value = value.subarray(1);
    if (value.length > integerBytes) throw new Error("DER signature integer is too large.");
    const padded = Buffer.alloc(integerBytes);
    value.copy(padded, integerBytes - value.length);
    return padded;
  };
  if (bytes[offset++] !== 0x30) throw new Error("DER signature sequence expected.");
  const sequenceLength = readLength();
  if (sequenceLength !== bytes.length - offset) throw new Error("DER signature length mismatch.");
  const r = readInteger();
  const s = readInteger();
  if (offset !== bytes.length) throw new Error("DER signature has trailing bytes.");
  return Buffer.concat([r, s]);
}

/** What a token signer receives: the JWS signing input and its SHA-256 digest. */
export interface ModelGatewayTokenSigningRequest {
  readonly digest: Uint8Array;
  readonly signingInput: Uint8Array;
}

/**
 * Signs gateway token claims as an ES256 compact JWS. `sign` returns a DER ECDSA P-256 signature
 * over the signing input: KMS `Sign` takes the digest (`MessageType: DIGEST`, `ECDSA_SHA_256`),
 * while a local key signs `signingInput` with SHA-256. `keyId` is the signing key's ARN, which the
 * gateway must trust.
 */
export async function signModelGatewayToken(input: {
  readonly claims: ModelGatewayTokenClaims;
  readonly keyId: string;
  readonly sign: (request: ModelGatewayTokenSigningRequest) => Promise<Uint8Array>;
}) {
  if (!parseModelGatewayTokenClaims(input.claims)) {
    throw new Error("Model gateway token claims are invalid.");
  }
  const signingInput = `${base64UrlJson({ alg: "ES256", kid: input.keyId, typ: "JWT" })}.${base64UrlJson(input.claims)}`;
  const signingInputBytes = Buffer.from(signingInput);
  const signature = derEcdsaSignatureToJose(
    await input.sign({
      digest: createHash("sha256").update(signingInputBytes).digest(),
      signingInput: signingInputBytes,
    }),
  );
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) return undefined;
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The claims of a token its bearer holds, read without verifying the signature. A caller reads
 * its own token's funding claim to record who paid; only the gateway's verification grants access.
 */
export function unverifiedModelGatewayTokenClaims(
  token: string,
): UnverifiedModelGatewayTokenClaims | undefined {
  const segments = token.split(".");
  return segments.length === 3
    ? parseModelGatewayTokenClaims(decodeSegment(segments[1]!))
    : undefined;
}

/**
 * Verifies a gateway token: ES256 signature by a trusted key (`publicKey` returns undefined for
 * an untrusted `kid`), issuer, audience, `iat`/`exp` within the clock skew, and a bounded
 * lifetime. Claim semantics beyond that (models, run activity) are the gateway's decision.
 */
export async function verifyModelGatewayToken(
  token: string,
  options: {
    readonly now: number;
    readonly publicKey: (keyId: string) => Promise<KeyObject | undefined>;
  },
): Promise<ModelGatewayTokenVerification> {
  const reject = (reason: ModelGatewayTokenRejection, message: string) =>
    ({ message, ok: false, reason }) as const;
  if (token.length > MAX_TOKEN_LENGTH) return reject("malformed", "Token is too long.");
  const segments = token.split(".");
  if (segments.length !== 3) return reject("malformed", "Token is not a compact JWS.");
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const header = decodeSegment(headerSegment);
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    return reject("malformed", "Token header is invalid.");
  }
  const { alg, kid, typ } = header as Record<string, unknown>;
  if (alg !== "ES256" || (typ !== undefined && typ !== "JWT")) {
    return reject("unsupported_algorithm", "Token must be an ES256 JWT.");
  }
  if (!nonEmptyString(kid)) return reject("unknown_key", "Token has no key id.");
  const key = await options.publicKey(kid);
  if (!key) return reject("unknown_key", "Token is signed by an untrusted key.");
  if (!/^[A-Za-z0-9_-]+$/u.test(signatureSegment)) {
    return reject("malformed", "Token signature is not base64url.");
  }
  const signature = Buffer.from(signatureSegment, "base64url");
  const signatureValid =
    signature.length === ES256_SIGNATURE_BYTES &&
    verify(
      "sha256",
      Buffer.from(`${headerSegment}.${payloadSegment}`),
      { dsaEncoding: "ieee-p1363", key },
      signature,
    );
  if (!signatureValid) return reject("bad_signature", "Token signature is invalid.");
  const parsed = parseModelGatewayTokenClaims(decodeSegment(payloadSegment));
  if (!parsed) return reject("invalid_claims", "Token claims are invalid.");
  const { aud, iss, ...registered } = parsed;
  if (iss !== MODEL_GATEWAY_TOKEN_ISSUER) {
    return reject("wrong_issuer", "Token issuer is not trusted.");
  }
  if (aud !== MODEL_GATEWAY_TOKEN_AUDIENCE) {
    return reject("wrong_audience", "Token audience is not the model gateway.");
  }
  const claims: ModelGatewayTokenClaims = { ...registered, aud, iss };
  const nowSeconds = Math.floor(options.now / 1000);
  if (claims.exp <= nowSeconds - MODEL_GATEWAY_TOKEN_CLOCK_SKEW_SECONDS) {
    return reject("expired", "Token has expired.");
  }
  if (claims.iat > nowSeconds + MODEL_GATEWAY_TOKEN_CLOCK_SKEW_SECONDS) {
    return reject("not_yet_valid", "Token was issued in the future.");
  }
  if (
    claims.exp - claims.iat > MODEL_GATEWAY_TOKEN_MAX_LIFETIME_SECONDS ||
    claims.exp <= claims.iat
  ) {
    return reject("lifetime_too_long", "Token lifetime exceeds the gateway limit.");
  }
  return { claims, ok: true };
}

/** Whether a token's model claim covers a canonical platform model id (case-insensitive). */
export function modelGatewayTokenAllowsModel(claims: ModelGatewayTokenClaims, modelId: string) {
  const normalized = modelId.toLowerCase();
  return claims.models.some((allowed) => allowed.toLowerCase() === normalized);
}
