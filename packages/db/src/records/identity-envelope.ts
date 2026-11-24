import { Schema } from "effect";
import { NonEmptyString } from "../record-schema.ts";

export const IdentityProtectedEnvelope = Schema.Struct({
  algorithm: Schema.Literal("AES-256-GCM"),
  authenticationTag: NonEmptyString,
  ciphertext: NonEmptyString,
  encryptedDataKey: NonEmptyString,
  encryptionContextHash: NonEmptyString,
  iv: NonEmptyString,
  schemaVersion: Schema.Literal(1),
});
