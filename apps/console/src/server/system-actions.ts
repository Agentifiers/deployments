import "@tanstack/react-start/server-only";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export type SystemStandingChangeResult = RouteResponse<"placeSystemOrganizationHold">;
export type SystemPrincipalStatus = RouteResponse<"replaceSystemPrincipalStatus">;
export type SystemOpenedAccess = RouteResponse<"openSystemOrganizationAccess">;
export type SystemClosedAccess = RouteResponse<"closeSystemOrganizationAccess">;

interface OrganizationWrite {
  readonly accessToken: string;
  readonly organizationId: string;
}

export function placeHold({
  accessToken,
  body,
  holdKey,
  organizationId,
}: OrganizationWrite & {
  readonly body: unknown;
  readonly holdKey: string;
}): Promise<SystemStandingChangeResult> {
  return callRoute(
    "placeSystemOrganizationHold",
    {
      body: decodeRequestBody(
        "placeSystemOrganizationHold",
        "PlaceSystemOrganizationHoldRequest",
        body,
      ),
      path: { holdKey, organizationId },
    },
    accessToken,
  );
}

export function releaseHold({
  accessToken,
  body,
  holdKey,
  organizationId,
}: OrganizationWrite & {
  readonly body: unknown;
  readonly holdKey: string;
}): Promise<SystemStandingChangeResult> {
  return callRoute(
    "releaseSystemOrganizationHold",
    {
      body: decodeRequestBody(
        "releaseSystemOrganizationHold",
        "ReleaseSystemOrganizationHoldRequest",
        body,
      ),
      path: { holdKey, organizationId },
    },
    accessToken,
  );
}

export function replaceEntitlements({
  accessToken,
  body,
  organizationId,
}: OrganizationWrite & { readonly body: unknown }): Promise<SystemStandingChangeResult> {
  return callRoute(
    "replaceSystemOrganizationEntitlements",
    {
      body: decodeRequestBody(
        "replaceSystemOrganizationEntitlements",
        "ReplaceSystemOrganizationEntitlementsRequest",
        body,
      ),
      path: { organizationId },
    },
    accessToken,
  );
}

export function clearEntitlements({
  accessToken,
  organizationId,
}: OrganizationWrite): Promise<SystemStandingChangeResult> {
  return callRoute(
    "clearSystemOrganizationEntitlements",
    { path: { organizationId } },
    accessToken,
  );
}

export function setDataBoundary({
  accessToken,
  body,
  organizationId,
}: OrganizationWrite & { readonly body: unknown }): Promise<SystemStandingChangeResult> {
  return callRoute(
    "setSystemOrganizationDataBoundary",
    {
      body: decodeRequestBody(
        "setSystemOrganizationDataBoundary",
        "SetSystemOrganizationDataBoundaryRequest",
        body,
      ),
      path: { organizationId },
    },
    accessToken,
  );
}

export function clearDataBoundary({
  accessToken,
  body,
  organizationId,
}: OrganizationWrite & { readonly body: unknown }): Promise<SystemStandingChangeResult> {
  return callRoute(
    "clearSystemOrganizationDataBoundary",
    {
      body: decodeRequestBody(
        "clearSystemOrganizationDataBoundary",
        "ClearSystemOrganizationDataBoundaryRequest",
        body,
      ),
      path: { organizationId },
    },
    accessToken,
  );
}

export function replacePrincipalStatus({
  accessToken,
  body,
  principalId,
}: {
  readonly accessToken: string;
  readonly body: unknown;
  readonly principalId: string;
}): Promise<SystemPrincipalStatus> {
  return callRoute(
    "replaceSystemPrincipalStatus",
    {
      body: decodeRequestBody(
        "replaceSystemPrincipalStatus",
        "ReplaceSystemPrincipalStatusRequest",
        body,
      ),
      path: { principalId },
    },
    accessToken,
  );
}

export function openOrganizationAccess({
  accessToken,
  body,
  organizationId,
}: OrganizationWrite & { readonly body: unknown }): Promise<SystemOpenedAccess> {
  return callRoute(
    "openSystemOrganizationAccess",
    {
      body: decodeRequestBody(
        "openSystemOrganizationAccess",
        "OpenSystemOrganizationAccessRequest",
        body,
      ),
      path: { organizationId },
    },
    accessToken,
  );
}

export function closeOrganizationAccess({
  accessToken,
  organizationId,
}: OrganizationWrite): Promise<SystemClosedAccess> {
  return callRoute("closeSystemOrganizationAccess", { path: { organizationId } }, accessToken);
}

export type SystemSessionsRevoked = RouteResponse<"revokeSystemPrincipalSessions">;
export type SystemVerificationSent = RouteResponse<"resendSystemPrincipalVerification">;

interface PrincipalWrite {
  readonly accessToken: string;
  readonly body: unknown;
  readonly principalId: string;
}

export function revokePrincipalSessions({
  accessToken,
  body,
  principalId,
}: PrincipalWrite): Promise<SystemSessionsRevoked> {
  return callRoute(
    "revokeSystemPrincipalSessions",
    {
      body: decodeRequestBody(
        "revokeSystemPrincipalSessions",
        "RevokeSystemPrincipalSessionsRequest",
        body,
      ),
      path: { principalId },
    },
    accessToken,
  );
}

export function resendPrincipalVerification({
  accessToken,
  body,
  principalId,
}: PrincipalWrite): Promise<SystemVerificationSent> {
  return callRoute(
    "resendSystemPrincipalVerification",
    {
      body: decodeRequestBody(
        "resendSystemPrincipalVerification",
        "ResendSystemPrincipalVerificationRequest",
        body,
      ),
      path: { principalId },
    },
    accessToken,
  );
}
