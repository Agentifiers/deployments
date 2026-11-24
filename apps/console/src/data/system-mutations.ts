import type {
  ClearSystemOrganizationDataBoundaryRequest,
  OpenSystemOrganizationAccessRequest,
  PlaceSystemOrganizationHoldRequest,
  ReleaseSystemOrganizationHoldRequest,
  ReplaceSystemOrganizationEntitlementsRequest,
  ReplaceSystemPrincipalStatusRequest,
  ResendSystemPrincipalVerificationRequest,
  RevokeSystemPrincipalSessionsRequest,
  SetSystemOrganizationDataBoundaryRequest,
} from "@deployments-ai/api-contract/system";
import { STANDING_NAME_PATTERN_SOURCE } from "@deployments-ai/api-contract/system";
import { createServerFn } from "@tanstack/react-start";
import { requireAccessToken } from "../server/session.ts";
import {
  clearDataBoundary,
  clearEntitlements,
  closeOrganizationAccess,
  openOrganizationAccess,
  placeHold,
  releaseHold,
  replaceEntitlements,
  replacePrincipalStatus,
  resendPrincipalVerification,
  revokePrincipalSessions,
  setDataBoundary,
} from "../server/system-actions.ts";
import { fields, requireBody, requireIds } from "./server-input.ts";

const HOLD_KEY = new RegExp(STANDING_NAME_PATTERN_SOURCE, "u");

type OrganizationInput = { readonly organizationId: string };

function holdInput(input: unknown) {
  const { holdKey } = fields(input);
  if (typeof holdKey !== "string" || !HOLD_KEY.test(holdKey)) {
    throw new TypeError("holdKey must be 1 to 63 lowercase letters, digits, or hyphens.");
  }
  return { ...requireIds(input, ["organizationId"]), holdKey };
}

export const placeHoldFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: OrganizationInput & {
        readonly body: typeof PlaceSystemOrganizationHoldRequest.Encoded;
        readonly holdKey: string;
      },
    ) => ({ ...holdInput(input), body: requireBody(input) }),
  )
  .handler(async ({ data }) => placeHold({ ...data, accessToken: await requireAccessToken() }));

export const releaseHoldFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: OrganizationInput & {
        readonly body: typeof ReleaseSystemOrganizationHoldRequest.Encoded;
        readonly holdKey: string;
      },
    ) => ({ ...holdInput(input), body: requireBody(input) }),
  )
  .handler(async ({ data }) => releaseHold({ ...data, accessToken: await requireAccessToken() }));

export const replaceEntitlementsFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: OrganizationInput & {
        readonly body: typeof ReplaceSystemOrganizationEntitlementsRequest.Encoded;
      },
    ) => ({ ...requireIds(input, ["organizationId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    replaceEntitlements({ ...data, accessToken: await requireAccessToken() }),
  );

export const clearEntitlementsFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationInput) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) =>
    clearEntitlements({ ...data, accessToken: await requireAccessToken() }),
  );

export const setDataBoundaryFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: OrganizationInput & {
        readonly body: typeof SetSystemOrganizationDataBoundaryRequest.Encoded;
      },
    ) => ({ ...requireIds(input, ["organizationId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    setDataBoundary({ ...data, accessToken: await requireAccessToken() }),
  );

export const clearDataBoundaryFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: OrganizationInput & {
        readonly body: typeof ClearSystemOrganizationDataBoundaryRequest.Encoded;
      },
    ) => ({ ...requireIds(input, ["organizationId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    clearDataBoundary({ ...data, accessToken: await requireAccessToken() }),
  );

export const replacePrincipalStatusFn = createServerFn({ method: "POST" })
  .validator(
    (input: {
      readonly body: typeof ReplaceSystemPrincipalStatusRequest.Encoded;
      readonly principalId: string;
    }) => ({ ...requireIds(input, ["principalId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    replacePrincipalStatus({ ...data, accessToken: await requireAccessToken() }),
  );

export const openOrganizationAccessFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: OrganizationInput & {
        readonly body: typeof OpenSystemOrganizationAccessRequest.Encoded;
      },
    ) => ({ ...requireIds(input, ["organizationId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    openOrganizationAccess({ ...data, accessToken: await requireAccessToken() }),
  );

export const closeOrganizationAccessFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationInput) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) =>
    closeOrganizationAccess({ ...data, accessToken: await requireAccessToken() }),
  );

export const revokePrincipalSessionsFn = createServerFn({ method: "POST" })
  .validator(
    (input: {
      readonly body: typeof RevokeSystemPrincipalSessionsRequest.Encoded;
      readonly principalId: string;
    }) => ({ ...requireIds(input, ["principalId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    revokePrincipalSessions({ ...data, accessToken: await requireAccessToken() }),
  );

export const resendPrincipalVerificationFn = createServerFn({ method: "POST" })
  .validator(
    (input: {
      readonly body: typeof ResendSystemPrincipalVerificationRequest.Encoded;
      readonly principalId: string;
    }) => ({ ...requireIds(input, ["principalId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    resendPrincipalVerification({ ...data, accessToken: await requireAccessToken() }),
  );
