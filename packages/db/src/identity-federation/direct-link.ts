import type { TransactionOperation } from "../client-types.ts";
import type { DirectoryReads } from "../directory/reads.ts";
import type { Ulid } from "../ids.ts";
import type { OrganizationDirectoryUserRecord } from "../records/directory.ts";
import type {
  IdentityBffRevocationFenceRecord,
  PrincipalSecurityStateRecord,
} from "../records/identity-auth.ts";
import type { PrincipalRecord } from "../records/identity.ts";
import type { OrganizationMemberRecord } from "../records/tenancy.ts";
import type { ProvisionedStanding } from "./linking.ts";
import { versionPin } from "./operations.ts";
import type { FederationReads } from "./reads.ts";
import { passwordCredentialKey } from "./record-keys.ts";

/** The records a direct link was decided on; the link write pins each one. */
export interface DirectLinkEvidence {
  readonly directoryUser: OrganizationDirectoryUserRecord;
  readonly fence: typeof IdentityBffRevocationFenceRecord.Type;
  readonly member: typeof OrganizationMemberRecord.Type;
  readonly principal: typeof PrincipalRecord.Type;
  readonly security: typeof PrincipalSecurityStateRecord.Type;
}

/** Reads the rest only when this organization's directory provisioned the principal. */
export async function provisionedStanding(input: {
  readonly directory: DirectoryReads;
  readonly organizationId: Ulid;
  readonly principal: typeof PrincipalRecord.Type;
  readonly reads: FederationReads;
}): Promise<ProvisionedStanding<DirectLinkEvidence> | undefined> {
  const { directory, organizationId, principal, reads } = input;
  const principalId = principal.data.id;
  const directoryUser = await directory.user(organizationId, principalId);
  if (directoryUser?.data.origin !== "provisioned") return undefined;
  const [member, security, fence, password, linkHere, memberElsewhere] = await Promise.all([
    reads.member(organizationId, principalId),
    reads.securityState(principalId),
    reads.bffFence(principalId),
    reads.passwordCredential(principalId),
    reads.organizationLink(organizationId, principalId),
    directory.belongsElsewhere(principalId, organizationId),
  ]);
  if (!member || !security || !fence) return undefined;
  return {
    evidence: { directoryUser, fence, member, principal, security },
    linkedHere: linkHere !== undefined,
    memberElsewhere,
    membershipActive: member.data.status === "active",
    passwordSet: password !== undefined,
    sessionEpoch: security.data.sessionEpoch,
  };
}

/**
 * A password set or a membership change after the read fails the write, so the retry decides
 * again. The security state is pinned by the session bump that every link carries.
 */
export function directLinkConditions(evidence: DirectLinkEvidence): TransactionOperation[] {
  return [
    versionPin(evidence.principal),
    versionPin(evidence.directoryUser),
    versionPin(evidence.member),
    {
      conditionExpression: "attribute_not_exists(pk)",
      key: passwordCredentialKey(evidence.principal.data.id),
      kind: "condition-check",
      table: "identity",
    },
  ];
}
