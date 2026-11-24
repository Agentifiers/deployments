import type { PlatformRecord } from "../records/index.ts";
import { claimOwnerAttributes, claimRequirement, claimValue } from "../unique-claim-requirement.ts";
import type { UniqueClaimRequirement } from "../unique-claims.ts";

export const APP_ID_CLAIM_NAMESPACE = "app-id";

export const VERIFIED_APP_HOSTNAME_CLAIM_NAMESPACE = "app-hostname";

export function appDomainSlotClaimNamespace(appId: string) {
  return `app:${appId}:domain-slot`;
}

export function appDomainHostnameClaimNamespace(appId: string) {
  return `app:${appId}:domain-hostname`;
}

export function appClaimRequirements(record: PlatformRecord): readonly UniqueClaimRequirement[] {
  switch (record.itemType) {
    case "app":
      return claimRequirement(record, APP_ID_CLAIM_NAMESPACE, claimValue(record.data, "id"));
    case "app-domain":
      return [
        ...claimRequirement(
          record,
          appDomainSlotClaimNamespace(record.data.appId),
          String(record.data.appSlot),
        ),
        ...claimRequirement(
          record,
          appDomainHostnameClaimNamespace(record.data.appId),
          record.data.hostname,
        ),
        ...(record.data.state.kind === "unverified"
          ? []
          : claimRequirement(record, VERIFIED_APP_HOSTNAME_CLAIM_NAMESPACE, record.data.hostname)),
      ];
    default:
      return [];
  }
}

export function appClaimOwnerAttributes(
  record: PlatformRecord,
): Readonly<Record<string, unknown>> | undefined {
  return record.itemType === "app-domain"
    ? claimOwnerAttributes(record.data, ["organizationId", "appId", "hostname"])
    : undefined;
}
