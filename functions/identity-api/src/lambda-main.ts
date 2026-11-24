import { KMSClient } from "@aws-sdk/client-kms";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { makeFederatedSignInStore, makeKmsEnvelopeAdapter } from "@deployments-ai/db";
import {
  makeFederationJwksCache,
  makeSiteverifyHumanVerifier,
  pinnedFederationHttp,
  randomToken,
} from "@deployments-ai/identity";
import { createLocalPlatformJwtVerifier } from "@deployments-ai/identity/platform-jwt";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { makeAccountAuthenticator } from "./account-authentication.ts";
import { makeDeviceApplication } from "./device-application.ts";
import { makeFederationApplication } from "./federation-application.ts";
import { parseHumanVerificationConfig } from "./human-verification-config.ts";
import { makeIdentityHttpHandler, type RestApiEvent } from "./http.ts";
import {
  applicationConfig,
  database,
  envelope,
  generateId,
  repository,
  required,
  requiredBoolean,
  runtimeApplication,
  stage,
} from "./identity-runtime.ts";
import { makeOAuthApplication } from "./oauth-application.ts";
import { makePublicEmailRequestQueue } from "./public-email-queue.ts";
import { makeKmsJwtSigner } from "./signer.ts";

const issuer = required("DEPLOYMENTS_AI_IDENTITY_ISSUER").replace(/\/$/u, "");
const uiOrigin = required("DEPLOYMENTS_AI_IDENTITY_UI_ORIGIN").replace(/\/$/u, "");
const applicationOrigin = required("DEPLOYMENTS_AI_IDENTITY_APPLICATION_ORIGIN").replace(
  /\/$/u,
  "",
);
const registrationEnabled = requiredBoolean("DEPLOYMENTS_AI_IDENTITY_REGISTRATION_ENABLED");
if (
  stage === "prod" &&
  (!issuer.startsWith("https://") ||
    !applicationOrigin.startsWith("https://") ||
    issuer !== uiOrigin)
) {
  throw new Error("Production identity issuer/UI origin must be the same HTTPS origin.");
}
const resourceAudience = required("DEPLOYMENTS_AI_IDENTITY_RESOURCE_AUDIENCE");
const signer = makeKmsJwtSigner({
  keyId: required("DEPLOYMENTS_AI_IDENTITY_SIGNING_KEY_ID"),
  kid: required("DEPLOYMENTS_AI_IDENTITY_SIGNING_KID"),
});
const oauth = makeOAuthApplication(
  {
    encryptEmailPayload: envelope.encrypt,
    generateId,
    reportSecurityNotificationFailure: (cause) => {
      console.error("A refresh-reuse notification could not be prepared.", { cause });
    },
    repository,
    signer,
  },
  {
    accessTokenSeconds: 600,
    authorizationCodeSeconds: 120,
    authorizationRequestSeconds: 600,
    idTokenSeconds: 600,
    issuer,
    refreshTokenSeconds: 30 * 24 * 60 * 60,
    resourceAudience,
  },
);
const device = makeDeviceApplication(
  { generateId, repository, signer },
  {
    accessTokenSeconds: 600,
    applicationOrigin,
    deviceLifetimeSeconds: 600,
    issuer,
    pollingIntervalSeconds: 5,
    refreshTokenSeconds: 30 * 24 * 60 * 60,
    resourceAudience,
  },
);
const sqs = new SQSClient({});
const publicEmailQueueUrl = required("DEPLOYMENTS_AI_IDENTITY_PUBLIC_EMAIL_QUEUE_URL");
const queuePublicEmailRequest = makePublicEmailRequestQueue({
  generateId,
  send: async (body) => {
    await sqs.send(new SendMessageCommand({ MessageBody: body, QueueUrl: publicEmailQueueUrl }), {
      abortSignal: AbortSignal.timeout(5_000),
    });
  },
});
/**
 * The identity-secret key seals both federation client secrets and TOTP secrets; the KMS grant
 * for each is pinned to its own `purpose` encryption context.
 */
const identitySecrets = makeKmsEnvelopeAdapter({
  keyId: required("DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID"),
  kms: new KMSClient({}),
  stage,
});
const application = runtimeApplication({ mfaSecrets: identitySecrets });
const federationHttp = pinnedFederationHttp({ timeoutMs: 3_000 });
const federation = makeFederationApplication(
  {
    decryptEnvelope: identitySecrets.decrypt,
    http: federationHttp,
    jwks: makeFederationJwksCache({ http: federationHttp, now: () => new Date() }),
    now: () => new Date(),
    store: makeFederatedSignInStore(
      {
        database,
        encryptEmailPayload: envelope.encrypt,
        generateId,
        newToken: () => randomToken(),
        now: () => new Date(),
      },
      {
        linkRequestLifetimeSeconds: 30 * 60,
        sessionAbsoluteLifetimeSeconds: applicationConfig.sessionAbsoluteLifetimeSeconds,
        sessionIdleLifetimeSeconds: applicationConfig.sessionIdleLifetimeSeconds,
        transactionLifetimeSeconds: 10 * 60,
      },
    ),
  },
  { applicationOrigin, issuer },
);
const humanVerification = parseHumanVerificationConfig(
  process.env.DEPLOYMENTS_AI_IDENTITY_HUMAN_VERIFICATION,
);

const accountAuthenticator = makeAccountAuthenticator({
  now: () => new Date(),
  repository,
  verify: createLocalPlatformJwtVerifier({
    audience: resourceAudience,
    issuer,
    keys: async () => ({ keys: [...(await signer.jwks()).keys] }),
  }),
});

export const handler = makeIdentityHttpHandler(
  application,
  {
    accountAuthenticator,
    applicationOrigin,
    ...(humanVerification
      ? {
          humanVerifier: makeSiteverifyHumanVerifier({
            readSecret: () => loadAwsSecretString(humanVerification.secretParameterArn),
            timeoutMs: 3_000,
            verifyUrl: humanVerification.verifyUrl,
            widget: humanVerification.widget,
          }),
        }
      : {}),
    issuer,
    publicResponseMinimumMs: Number(
      process.env.DEPLOYMENTS_AI_IDENTITY_PUBLIC_RESPONSE_MINIMUM_MS ?? 500,
    ),
    queuePublicEmailRequest,
    registrationEnabled,
    secureCookies: stage !== "local",
    uiOrigin,
  },
  { device, oauth, signer },
  federation,
);

export default (event: RestApiEvent) => handler(event);
