import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";
import { IdentityProtectedEnvelope } from "./identity-envelope.ts";

/** Providers whose gateway integration accepts a bare API key; Bedrock authenticates with IAM. */
export const BYOK_PROVIDERS = ["openai", "openrouter"] as const;
export const ByokProvider = Schema.Literals(BYOK_PROVIDERS);
export type ByokProvider = typeof ByokProvider.Type;

export const ModelProviderCredentialLabel = NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(100)),
);

const KeyVersion = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);

export const ModelProviderCredentialState = Schema.Union([
  Schema.Struct({ envelope: IdentityProtectedEnvelope, kind: Schema.Literal("active") }),
  Schema.Struct({ kind: Schema.Literal("revoked"), revokedAt: Timestamp, revokedBy: Ulid }),
]);

/**
 * The organization's key for one provider, keyed `ORG#<organizationId>` /
 * `MODEL-PROVIDER-CREDENTIAL#<provider>`. Only an active credential holds ciphertext; removal
 * keeps the metadata of the last key as its audit trail.
 */
export const ModelProviderCredentialRecord = makeRecordSchema("model-provider-credential", {
  ...mutableResourceFields,
  credentialId: Ulid,
  id: ByokProvider,
  keyVersion: KeyVersion,
  label: Schema.optionalKey(ModelProviderCredentialLabel),
  lastFour: Schema.String.pipe(Schema.check(Schema.isLengthBetween(4, 4))),
  organizationId: Ulid,
  setAt: Timestamp,
  setBy: Ulid,
  state: ModelProviderCredentialState,
});
export type ModelProviderCredentialRecord = typeof ModelProviderCredentialRecord.Type;

export const MODEL_CREDENTIAL_RECORD_SCHEMAS = {
  "model-provider-credential": ModelProviderCredentialRecord,
} as const;
