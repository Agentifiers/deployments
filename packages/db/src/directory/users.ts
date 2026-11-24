import { Schema } from "effect";
import { organizationAuditOperationForEvent } from "../audit/organization-audit-log.ts";
import type { TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { newHumanPrincipalOperations } from "../identity/principal-creation.ts";
import {
  replaceWithClaims,
  type AdministrationContext,
  type AdministrationEvent,
} from "../identity-federation/administration-context.ts";
import {
  createWithClaims,
  deleteWithClaims,
  versionPin,
} from "../identity-federation/operations.ts";
import {
  memberActivation,
  memberRemoval,
  type MembershipChange,
} from "../organization-membership-changes.ts";
import type { OrganizationDirectoryUserRecord } from "../records/directory.ts";
import { LoginDomain } from "../records/identity-federation.ts";
import { PrincipalRecord } from "../records/identity.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import type { OrganizationMember } from "../tenancy-contracts.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import type { DirectoryCaller } from "./administration.ts";
import type { DirectoryReads, DirectoryUserAttribute } from "./reads.ts";
import { directoryRecord } from "./record-builders.ts";
import {
  planDirectoryChange,
  planDirectoryCreate,
  planDirectoryDelete,
  type DirectoryRefusal,
  type DirectoryUserChange,
  type MembershipStep,
  type NewDirectoryUser,
} from "./user-plan.ts";

const WRITE_ATTEMPTS = 5;
const AGGREGATE_TYPE = "organization-directory-user";

/** An organization's view of one directory user. `id` is the principal ID. */
export interface DirectoryUser {
  readonly active: boolean;
  readonly created: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly externalId?: string;
  readonly id: Ulid;
  readonly lastModified: string;
  readonly userName: string;
}

export interface DirectoryUserQuery {
  /** At most 100; zero asks only for `totalResults`. */
  readonly count: number;
  readonly filter?: { readonly attribute: DirectoryUserAttribute; readonly value: string };
  /** One-based, as in SCIM. */
  readonly startIndex: number;
}

export interface DirectoryUserPage {
  readonly items: readonly DirectoryUser[];
  readonly startIndex: number;
  readonly totalResults: number;
}

export type DirectoryResult<Value> =
  | { readonly kind: "ok"; readonly value: Value }
  | { readonly kind: "refused"; readonly reason: DirectoryRefusal };

export interface DirectoryUsers {
  readonly change: (
    caller: DirectoryCaller,
    principalId: Ulid,
    change: DirectoryUserChange,
  ) => Promise<DirectoryResult<DirectoryUser>>;
  readonly create: (
    caller: DirectoryCaller,
    user: NewDirectoryUser,
  ) => Promise<DirectoryResult<DirectoryUser>>;
  readonly delete: (caller: DirectoryCaller, principalId: Ulid) => Promise<DirectoryResult<null>>;
  readonly get: (
    caller: DirectoryCaller,
    principalId: Ulid,
  ) => Promise<DirectoryResult<DirectoryUser>>;
  readonly list: (caller: DirectoryCaller, query: DirectoryUserQuery) => Promise<DirectoryUserPage>;
}

export class DirectoryContentionError extends Error {
  constructor() {
    super("The directory user kept changing concurrently; retry the request.");
    this.name = "DirectoryContentionError";
  }
}

const refused = (reason: DirectoryRefusal) => ({ kind: "refused", reason }) as const;

interface DirectoryWrite {
  /** The directory user's event first: it is the one the audit log records. */
  readonly events: readonly Omit<AdministrationEvent, "occurredAt">[];
  readonly operations: readonly TransactionOperation[];
  readonly principalId: Ulid;
}

type Attempt =
  | { readonly kind: "refused"; readonly reason: DirectoryRefusal }
  | { readonly kind: "unchanged"; readonly principalId: Ulid }
  | { readonly kind: "write"; readonly write: DirectoryWrite };

type Settled =
  | { readonly kind: "refused"; readonly reason: DirectoryRefusal }
  | { readonly kind: "settled"; readonly principalId: Ulid };

function activeAfter(step: MembershipStep, membership: OrganizationMember | undefined) {
  return step.kind === "keep" ? membership?.data.status === "active" : step.kind === "activate";
}

export function makeDirectoryUsers(
  context: AdministrationContext,
  reads: DirectoryReads,
): DirectoryUsers {
  const federation = context.reads;

  async function view(record: OrganizationDirectoryUserRecord): Promise<DirectoryUser> {
    const { data } = record;
    const [principal, membership] = await Promise.all([
      federation.principal(data.id),
      federation.member(data.organizationId, data.id),
    ]);
    const membershipChangedLast = membership && membership.data.updatedAt > data.updatedAt;
    return {
      active: membership?.data.status === "active",
      created: data.createdAt,
      ...(principal?.data.displayName ? { displayName: principal.data.displayName } : {}),
      ...(principal?.data.primaryEmail ? { email: principal.data.primaryEmail } : {}),
      ...(data.externalId === undefined ? {} : { externalId: data.externalId }),
      id: data.id,
      lastModified: membershipChangedLast ? membership.data.updatedAt : data.updatedAt,
      userName: data.userName,
    };
  }

  async function get(caller: DirectoryCaller, principalId: Ulid) {
    const record = await reads.user(caller.organizationId, principalId);
    return record
      ? ({ kind: "ok", value: await view(record) } as const)
      : refused("user_not_found");
  }

  async function requiredDirectory(organizationId: Ulid) {
    const directory = await reads.directory(organizationId);
    if (!directory) throw new Error("A directory caller's organization has no directory.");
    return directory;
  }

  /** The other principal holding `value` for `attribute` in the organization, if any. */
  async function heldElsewhere(
    caller: DirectoryCaller,
    principalId: Ulid | undefined,
    attribute: DirectoryUserAttribute,
    value: string | null | undefined,
  ) {
    if (value === undefined || value === null) return undefined;
    const holder = await reads.userWith(caller.organizationId, attribute, value);
    return holder && holder.data.id !== principalId ? holder.data.id : undefined;
  }

  async function membershipChange(input: {
    readonly at: string;
    readonly existing: OrganizationMember | undefined;
    readonly organizationId: Ulid;
    readonly principalId: Ulid;
    readonly step: MembershipStep;
  }): Promise<Pick<MembershipChange, "events" | "operations">> {
    const { at, existing, organizationId, principalId, step } = input;
    switch (step.kind) {
      case "keep":
        return { events: [], operations: [] };
      case "activate":
        return memberActivation({
          at,
          existing,
          organizationId,
          principalId,
          role: step.role,
          source: { kind: "scim" },
        });
      case "remove": {
        if (!existing) throw new Error("Only an existing membership can be removed.");
        const organization = await federation.organization(organizationId);
        if (!organization) throw new Error("A membership's organization is missing.");
        return memberRemoval({ at, organization, previous: existing, source: { kind: "scim" } });
      }
      default: {
        const unhandled: never = step;
        return unhandled;
      }
    }
  }

  function userEvent(record: OrganizationDirectoryUserRecord, eventType: string, active: boolean) {
    return {
      aggregateId: record.data.id,
      aggregateType: AGGREGATE_TYPE,
      aggregateVersion: record.data.version,
      eventType,
      payload: { active, origin: record.data.origin, principalId: record.data.id },
    };
  }

  async function commit(caller: DirectoryCaller, write: DirectoryWrite, at: string) {
    const events = write.events.map((event) =>
      makeSemanticEventRecord({
        ...event,
        actor: { id: caller.tokenId, type: "directory-token" },
        eventId: context.generateId(),
        occurredAt: at,
        organizationId: caller.organizationId,
      }),
    );
    const [primary] = events;
    if (!primary) throw new Error("A directory write needs its directory user event.");
    await transactWithSemanticEvents(
      context.database,
      [
        ...write.operations,
        organizationAuditOperationForEvent(primary, {
          id: caller.tokenId,
          type: "directory-token",
        }),
      ],
      events,
    );
  }

  /** Plans and writes until a write lands, the plan settles, or contention outlasts the retries. */
  async function retrying(
    caller: DirectoryCaller,
    attempt: (at: string) => Promise<Attempt>,
  ): Promise<Settled> {
    for (let tries = 0; tries < WRITE_ATTEMPTS; tries += 1) {
      const at = context.now().toISOString();
      const outcome = await attempt(at);
      switch (outcome.kind) {
        case "refused":
          return outcome;
        case "unchanged":
          return { kind: "settled", principalId: outcome.principalId };
        case "write":
          try {
            await commit(caller, outcome.write, at);
            return { kind: "settled", principalId: outcome.write.principalId };
          } catch (error) {
            if (!isDatabaseWriteConflict(error)) throw error;
          }
          break;
        default: {
          const unhandled: never = outcome;
          return unhandled;
        }
      }
    }
    throw new DirectoryContentionError();
  }

  async function settledView(
    caller: DirectoryCaller,
    settled: Settled,
  ): Promise<DirectoryResult<DirectoryUser>> {
    return settled.kind === "refused" ? settled : get(caller, settled.principalId);
  }

  async function createAttempt(
    caller: DirectoryCaller,
    input: NewDirectoryUser,
    at: string,
  ): Promise<Attempt> {
    const { organizationId } = caller;
    const domain = Schema.decodeUnknownOption(LoginDomain)(input.email.split("@")[1]);
    const [directory, loginDomain, existing, userNameOwner, externalIdOwner] = await Promise.all([
      requiredDirectory(organizationId),
      domain._tag === "Some" ? federation.loginDomain(organizationId, domain.value) : undefined,
      federation.principalForEmail(input.email),
      heldElsewhere(caller, undefined, "userName", input.userName),
      heldElsewhere(caller, undefined, "externalId", input.externalId),
    ]);
    const [mapped, membership] = existing
      ? await Promise.all([
          reads.user(organizationId, existing.data.id),
          federation.member(organizationId, existing.data.id),
        ])
      : [undefined, undefined];
    const plan = planDirectoryCreate(
      {
        defaultRole: directory.data.defaultRole,
        domainVerified: loginDomain?.data.state.kind === "verified",
        externalIdOwner,
        principal: existing
          ? {
              eligible:
                existing.data.kind === "human" &&
                existing.data.status === "active" &&
                existing.data.platformRole === undefined,
              id: existing.data.id,
              kind: "present",
              mapped: mapped !== undefined,
              membership: membership?.data,
            }
          : { kind: "absent" },
        userNameOwner,
      },
      input,
    );
    if (plan.kind === "refused") return plan;
    if (!loginDomain) throw new Error("A planned directory user has no verified domain.");

    const principalId = plan.kind === "adopt" ? plan.principalId : context.generateId();
    const user = directoryRecord("organization-directory-user", {
      createdAt: at,
      ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
      id: principalId,
      organizationId,
      origin: plan.kind === "adopt" ? "adopted" : "provisioned",
      updatedAt: at,
      userName: input.userName,
      version: await context.nextAggregateVersion(organizationId, AGGREGATE_TYPE, principalId),
    });
    const membershipWrite = await membershipChange({
      at,
      existing: membership,
      organizationId,
      principalId,
      step: plan.membership,
    });
    const principalOperations =
      plan.kind === "adopt" && existing
        ? [versionPin(existing)]
        : newHumanPrincipalOperations({
            createdAt: at,
            ...(input.displayName ? { displayName: input.displayName } : {}),
            eventId: context.generateId(),
            mailbox: "verified",
            primaryEmail: input.email,
            principalId,
          });
    return {
      kind: "write",
      write: {
        events: [
          userEvent(
            user,
            "organization-directory-user.created",
            activeAfter(plan.membership, membership),
          ),
          ...membershipWrite.events,
        ],
        operations: [
          versionPin(directory),
          versionPin(loginDomain),
          ...principalOperations,
          ...createWithClaims(user, at),
          ...membershipWrite.operations,
        ],
        principalId,
      },
    };
  }

  async function changeAttempt(
    caller: DirectoryCaller,
    principalId: Ulid,
    change: DirectoryUserChange,
    at: string,
  ): Promise<Attempt> {
    const { organizationId } = caller;
    const current = await reads.user(organizationId, principalId);
    if (!current) return refused("user_not_found");
    const [directory, principal, membership, otherMemberships, userNameOwner, externalIdOwner] =
      await Promise.all([
        requiredDirectory(organizationId),
        federation.principal(principalId),
        federation.member(organizationId, principalId),
        reads.belongsElsewhere(principalId, organizationId),
        heldElsewhere(caller, principalId, "userName", change.userName),
        heldElsewhere(caller, principalId, "externalId", change.externalId),
      ]);
    if (!principal) throw new Error("A directory user's principal is missing.");
    const plan = planDirectoryChange(
      {
        defaultRole: directory.data.defaultRole,
        externalIdOwner,
        mapping: current.data,
        membership: membership?.data,
        otherMemberships,
        principal: principal.data,
        userNameOwner,
      },
      change,
    );
    if (plan.kind === "refused") return plan;
    if (plan.kind === "unchanged") return { kind: "unchanged", principalId };

    const { externalId: _externalId, ...kept } = current.data;
    const user = directoryRecord("organization-directory-user", {
      ...kept,
      ...(plan.mapping.externalId === undefined ? {} : { externalId: plan.mapping.externalId }),
      updatedAt: at,
      userName: plan.mapping.userName,
      version: current.data.version + 1,
    });
    const membershipWrite = await membershipChange({
      at,
      existing: membership,
      organizationId,
      principalId,
      step: plan.membership,
    });
    const renamed =
      plan.displayName === undefined
        ? []
        : [
            {
              kind: "put" as const,
              previousRecord: principal,
              record: Schema.decodeUnknownSync(PrincipalRecord)(
                withCanonicalRecordKeys({
                  data: {
                    ...principal.data,
                    displayName: plan.displayName,
                    updatedAt: at,
                    version: principal.data.version + 1,
                  },
                  itemType: "principal" as const,
                }),
              ),
            },
          ];
    return {
      kind: "write",
      write: {
        events: [
          userEvent(
            user,
            "organization-directory-user.updated",
            activeAfter(plan.membership, membership),
          ),
          ...membershipWrite.events,
        ],
        operations: [
          versionPin(directory),
          ...replaceWithClaims(current, user, at),
          ...renamed,
          ...membershipWrite.operations,
        ],
        principalId,
      },
    };
  }

  async function deleteAttempt(
    caller: DirectoryCaller,
    principalId: Ulid,
    at: string,
  ): Promise<Attempt> {
    const current = await reads.user(caller.organizationId, principalId);
    if (!current) return refused("user_not_found");
    const membership = await federation.member(caller.organizationId, principalId);
    const plan = planDirectoryDelete(membership?.data);
    if (plan.kind === "refused") return plan;
    const membershipWrite = await membershipChange({
      at,
      existing: membership,
      organizationId: caller.organizationId,
      principalId,
      step: plan.membership,
    });
    return {
      kind: "write",
      write: {
        events: [
          {
            ...userEvent(current, "organization-directory-user.deleted", false),
            aggregateVersion: current.data.version + 1,
          },
          ...membershipWrite.events,
        ],
        operations: [...deleteWithClaims(current), ...membershipWrite.operations],
        principalId,
      },
    };
  }

  return {
    change: async (caller, principalId, change) =>
      settledView(
        caller,
        await retrying(caller, (at) => changeAttempt(caller, principalId, change, at)),
      ),

    create: async (caller, user) =>
      settledView(caller, await retrying(caller, (at) => createAttempt(caller, user, at))),

    delete: async (caller, principalId) => {
      const settled = await retrying(caller, (at) => deleteAttempt(caller, principalId, at));
      return settled.kind === "refused" ? settled : { kind: "ok", value: null };
    },

    get,

    list: async (caller, query) => {
      const { filter } = query;
      const matching = filter
        ? await reads
            .userWith(caller.organizationId, filter.attribute, filter.value)
            .then((user) => (user ? [user] : []))
        : await reads.users(caller.organizationId);
      const page = matching.slice(query.startIndex - 1, query.startIndex - 1 + query.count);
      return {
        items: await Promise.all(page.map(view)),
        startIndex: query.startIndex,
        totalResults: matching.length,
      };
    },
  };
}
