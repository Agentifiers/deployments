import {
  makePrincipalCommandHandler,
  makePrincipalSecurityRepository,
  makePrincipalStatusRepository,
} from "@deployments-ai/db";
import { DEFAULT_PASSWORD_PROFILE, systemRandom } from "@deployments-ai/identity";
import {
  applicationConfig,
  database,
  envelope,
  generateId,
  repository,
  requiredBoolean,
} from "./identity-runtime.ts";
import { DEFAULT_IDENTITY_RATE_LIMIT_POLICIES } from "./rate-limits.ts";
import { makeRegistrationApplication } from "./registration-application.ts";

const registrationEnabled = requiredBoolean("DEPLOYMENTS_AI_IDENTITY_REGISTRATION_ENABLED");
const registration = makeRegistrationApplication(
  {
    encryptEmailPayload: envelope.encrypt,
    generateId,
    now: () => new Date(),
    random: systemRandom,
    repository,
  },
  {
    actionLifetimeSeconds: applicationConfig.actionLifetimeSeconds,
    passwordProfile: DEFAULT_PASSWORD_PROFILE,
    rateLimits: DEFAULT_IDENTITY_RATE_LIMIT_POLICIES,
    registrationLifetimeSeconds: applicationConfig.registrationLifetimeSeconds,
  },
);

export const handler = makePrincipalCommandHandler({
  reissueVerification: async (command) =>
    registrationEnabled
      ? registration.reissueVerification(command)
      : { outcome: "registration-closed" },
  security: makePrincipalSecurityRepository({ database, generateId }),
  statuses: makePrincipalStatusRepository({ database }),
});
