import {
  CreateBrainRequest,
  type BrainGrantResponse,
  type BrainMountResponse,
  type BrainSourceResponse,
  type BrainResponse,
  type CreateBrainGrantRequest,
  type CreateBrainMountRequest,
  type UpdateBrainRequest,
} from "@deployments-ai/api-contract/brains";
import { Schema } from "effect";
import type { MemberView } from "../members/roles.ts";
import type { ConsoleAuthorization } from "../permissions.ts";

export type BrainKind = CreateBrainRequest["kind"];
export type BrainSensitivity = NonNullable<CreateBrainRequest["sensitivity"]>;
export type BrainGrant = BrainGrantResponse;
export type BrainMount = BrainMountResponse;
export type BrainSource = Omit<BrainSourceResponse, "configuration">;
export type MachineGrantPermission = "read" | "read-write";

export type CreateBrainBody = typeof CreateBrainRequest.Encoded;
export type UpdateBrainBody = typeof UpdateBrainRequest.Encoded;
export type GrantBody = typeof CreateBrainGrantRequest.Encoded;
export type MountBody = typeof CreateBrainMountRequest.Encoded;

export const BRAIN_SENSITIVITIES = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const satisfies readonly BrainSensitivity[];

export const KIND_LABELS: Readonly<Record<BrainKind, string>> = {
  company: "Company",
  "member-private": "Private",
};

const RESEND = "Submitting again sends this request unchanged.";

const VERSIONED = `${RESEND} If the first attempt went through, the repeat stops at a version conflict and the console loads the latest version. To change the request, choose Leave unfinished and open the dialog again.`;

function checkFirst(outcome: string, place: string): string {
  return `${RESEND} ${outcome} Leave unfinished reloads ${place} so you can check before you open the dialog again.`;
}

/**
 * Brain writes answer a refused body with a 500 that the console cannot tell from a lost write,
 * and that 500 releases the idempotency key, so a resend runs the write again. Each notice names
 * what, if anything, refuses that second run.
 */
export const BRAIN_RETRY_NOTICES = {
  create: checkFirst(
    "A slug names one Brain, so if the first attempt went through, a repeat cannot create a second one and may fail with an internal error.",
    "the Brains list",
  ),
  edit: VERSIONED,
  grant: checkFirst(
    "A grantee holds one active grant on a Brain, so if the first attempt went through, a repeat cannot add a second one and may fail with an internal error.",
    "the grants",
  ),
  mount: checkFirst(
    "A deployment mounts a Brain once, so if the first attempt went through, a repeat cannot add a second mount and may fail with an internal error.",
    "the mounts",
  ),
  revoke: VERSIONED,
  uploadSource: checkFirst(
    "Nothing refuses a second upload source, so if the first attempt went through, a repeat adds another one.",
    "Sources",
  ),
};

export type BrainStanding = { readonly kind: "owner" } | { readonly kind: "grantee" };

export interface BrainView {
  readonly brain: BrainResponse;
  readonly standing: BrainStanding;
}

export function canCreateBrain(authorization: ConsoleAuthorization): boolean {
  return authorization.organizationRole !== undefined;
}

export function canOfferCompanyBrain(authorization: ConsoleAuthorization): boolean {
  return authorization.organizationRole === "owner" || authorization.organizationRole === "admin";
}

export const isBrainSlug: (value: string) => boolean = Schema.is(CreateBrainRequest.fields.slug);

const MAX_SLUG_LENGTH = 80;

export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/gu, "");
}

export function editBrainBody(
  base: Pick<BrainResponse, "name" | "sensitivity" | "slug" | "version">,
  edit: Pick<BrainResponse, "name" | "sensitivity" | "slug">,
): UpdateBrainBody {
  const name = edit.name.trim();
  return {
    expectedVersion: base.version,
    ...(name === base.name ? {} : { name }),
    ...(edit.sensitivity === base.sensitivity ? {} : { sensitivity: edit.sensitivity }),
    ...(edit.slug === base.slug ? {} : { slug: edit.slug }),
  };
}

export type GrantDraft =
  | {
      readonly kind: "principal";
      readonly permission: "curator" | "owner" | "reader" | "writer";
      readonly principalId: string;
    }
  | {
      readonly kind: "organization-role";
      readonly organizationRole: "admin" | "member" | "owner";
      readonly permission: "curator" | "reader" | "writer";
    }
  | {
      readonly environmentId: string;
      readonly kind: "service-account";
      readonly permission: MachineGrantPermission;
      readonly projectId: string;
      readonly serviceAccountId: string;
    }
  | {
      readonly agentDefinitionId: string;
      readonly environmentId: string;
      readonly kind: "agent-definition";
      readonly permission: MachineGrantPermission;
      readonly projectId: string;
    };

export function grantRequest(draft: GrantDraft): GrantBody {
  switch (draft.kind) {
    case "principal":
      return {
        permission: draft.permission,
        target: { principalId: draft.principalId, type: "principal" },
      };
    case "organization-role":
      return {
        permission: draft.permission,
        target: { organizationRole: draft.organizationRole, type: "organization-role" },
      };
    case "service-account":
      return {
        permission: draft.permission,
        target: {
          environmentId: draft.environmentId,
          projectId: draft.projectId,
          serviceAccountId: draft.serviceAccountId,
          type: "service-account",
        },
      };
    case "agent-definition":
      return {
        permission: draft.permission,
        target: {
          agentDefinitionId: draft.agentDefinitionId,
          environmentId: draft.environmentId,
          projectId: draft.projectId,
          type: "agent-definition",
        },
      };
    default: {
      const exhaustive: never = draft;
      return exhaustive;
    }
  }
}

export function grantKindsFor(kind: BrainKind): readonly GrantDraft["kind"][] {
  return kind === "company"
    ? ["principal", "organization-role", "agent-definition", "service-account"]
    : ["agent-definition", "service-account"];
}

export function grantablePeople(
  members: readonly MemberView[],
  grants: readonly BrainGrant[],
): readonly MemberView[] {
  const granted = new Set(
    grants.flatMap(({ status, target }) =>
      status === "active" && target.type === "principal" ? [target.principalId] : [],
    ),
  );
  return members.filter((member) => member.status === "active" && !granted.has(member.principalId));
}

export function revokeRefusal(
  brain: Pick<BrainResponse, "kind">,
  grant: BrainGrant,
  activeGrants: readonly BrainGrant[],
): string | undefined {
  if (grant.status !== "active" || grant.permission !== "owner") return undefined;
  if (brain.kind === "member-private") return "A private Brain always keeps its owner.";
  const owners = activeGrants.filter(
    (candidate) => candidate.status === "active" && candidate.permission === "owner",
  );
  return owners.length <= 1 ? "A company Brain keeps at least one owner." : undefined;
}

/**
 * The grant or mount being revoked, read from the latest list so a revoke after a 409 sends its
 * current version, and the dialog closes once the record is no longer active.
 */
export function activeRecord<Item extends { readonly id: string; readonly status: string }>(
  items: readonly Item[],
  id: string | undefined,
): Item | undefined {
  return items.find((item) => item.id === id && item.status === "active");
}

interface MountTarget {
  readonly agentDefinitionId: string;
  readonly environmentId: string;
  readonly projectId: string;
}

export function mountRefusal(
  target: MountTarget,
  permission: MachineGrantPermission,
  grants: readonly BrainGrant[],
): string | undefined {
  const grant = grants.find(
    ({ status, target: granted }) =>
      status === "active" &&
      granted.type === "agent-definition" &&
      granted.agentDefinitionId === target.agentDefinitionId &&
      granted.environmentId === target.environmentId &&
      granted.projectId === target.projectId,
  );
  if (grant === undefined) {
    return "Grant this agent access to the Brain first. A mount needs an agent grant in this environment.";
  }
  return permission === "read-write" && grant.permission !== "read-write"
    ? "The agent's grant is read-only, so the mount can only read."
    : undefined;
}
