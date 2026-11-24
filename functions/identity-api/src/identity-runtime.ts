import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  Ulid,
  makeDynamoDatabase,
  makeIdentityRepository,
  makeAccountStandingRepository,
  makeKmsEnvelopeAdapter,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { monotonicFactory } from "ulid";
import { makeIdentityApplication, type IdentityApplicationDependencies } from "./application.ts";
import { DEFAULT_IDENTITY_RATE_LIMIT_POLICIES } from "./rate-limits.ts";

export function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function requiredBoolean(name: string) {
  const value = required(name).toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

export const stage = required("DEPLOYMENTS_AI_STAGE");
export const database = makeDynamoDatabase(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  tableNamesFromEnvironment(),
);
export const envelope = makeKmsEnvelopeAdapter({
  keyId: required("DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID"),
  kms: new KMSClient({}),
  stage,
});
const id = monotonicFactory();
export const generateId = () => Schema.decodeUnknownSync(Ulid)(id());
export const repository = makeIdentityRepository(database);
export const applicationConfig = {
  actionLifetimeSeconds: 30 * 60,
  registrationLifetimeSeconds: 24 * 60 * 60,
  sessionAbsoluteLifetimeSeconds: 30 * 24 * 60 * 60,
  sessionIdleLifetimeSeconds: 24 * 60 * 60,
};
const applicationDependencies = {
  accountStanding: makeAccountStandingRepository({ database, generateId }),
  encryptEmailPayload: envelope.encrypt,
  generateId,
  repository,
};

/**
 * The identity application for one Lambda. Only the API seals TOTP secrets, so only it passes
 * `mfaSecrets` and needs the identity-secret key; the public email worker signs people up and
 * starts password recovery, and must start without that key.
 */
export function runtimeApplication(
  extra: Pick<IdentityApplicationDependencies, "mfaSecrets"> = {},
) {
  return makeIdentityApplication(
    { ...applicationDependencies, ...extra },
    { ...applicationConfig, rateLimits: DEFAULT_IDENTITY_RATE_LIMIT_POLICIES },
  );
}
