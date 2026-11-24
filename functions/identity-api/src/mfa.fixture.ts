import { makeIdentityRepository, type DynamoDatabaseService } from "@deployments-ai/db";

const unusedDatabase = {} as DynamoDatabaseService;

/** Repository members a hand-built sign-in stub needs when the principal has no second factor. */
export const noMfaFactor = {
  mfaFactorForPrincipal: () => Promise.resolve(undefined),
  mfaFactorInactiveCheck: makeIdentityRepository(unusedDatabase).mfaFactorInactiveCheck,
};
