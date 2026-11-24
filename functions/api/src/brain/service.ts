import type {
  ArchiveBrainRequest,
  CreateBrainGrantRequest,
  CreateBrainMountRequest,
  CreateBrainRequest,
  RevokeBrainGrantRequest,
  RevokeBrainMountRequest,
  ResolveBrainReviewItemRequest,
} from "@deployments-ai/api-contract";
import {
  authorizeBrainAccess,
  type Brain,
  type BrainGrant,
  type BrainOperation,
  type BrainRepository,
} from "@deployments-ai/brains";
import {
  canHoldBrainRoleGrant,
  key,
  PersistenceError,
  type DynamoDatabaseService,
  type PlatformRecord,
  apiPersistence,
} from "@deployments-ai/db";
import { failure } from "../persistence-failure.ts";
import { requiredParam } from "./invocation-parameters.ts";
import { invokeBrainKnowledgeRoute } from "./knowledge-service.ts";
import { invokeBrainUploadRoute } from "./upload-routes.ts";
import { invokeBrainLifecycleRoute } from "./lifecycle-service.ts";
import { recordBrainFeedback } from "./feedback-service.ts";
import { invokeBrainQueryRoute } from "./query-service.ts";
import type {
  BrainApiInvocation,
  BrainApiService,
  BrainApiServiceDependencies,
} from "./service-contracts.ts";

function expectedVersion(body: unknown) {
  return (body as RevokeBrainGrantRequest | RevokeBrainMountRequest | ArchiveBrainRequest)
    .expectedVersion;
}

function oneIdentityScope(values: readonly string[] | "*" | undefined) {
  return values !== "*" && values?.length === 1 ? values[0] : undefined;
}

async function getRecord(
  database: DynamoDatabaseService,
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return await apiPersistence.read(database, "control", recordKey, true);
}

function activeOrganization(record: PlatformRecord | undefined, organizationId: string) {
  return (
    record?.itemType === "organization" &&
    record.data.id === organizationId &&
    record.data.status === "active"
  );
}

async function currentOwnerIsActive(
  database: DynamoDatabaseService,
  brain: Brain,
): Promise<boolean> {
  if (brain.kind === "company") return true;
  const ownerId = brain.ownerPrincipalId;
  if (!ownerId) return false;
  const [principal, membership] = await Promise.all([
    getRecord(database, {
      pk: key("PRINCIPAL", ownerId),
      sk: key("PRINCIPAL", ownerId),
    }),
    getRecord(database, {
      pk: key("ORG", brain.organizationId),
      sk: key("ORGANIZATION-MEMBER", ownerId),
    }),
  ]);
  return (
    principal?.itemType === "principal" &&
    principal.data.kind === "human" &&
    principal.data.status === "active" &&
    membership?.itemType === "organization-member" &&
    membership.data.status === "active"
  );
}

async function authorize(
  dependencies: BrainApiServiceDependencies,
  invocation: BrainApiInvocation,
  brain: Brain,
  operation: BrainOperation,
) {
  const { database, repository } = dependencies;
  const identity = invocation.identity;
  const organizationAndOwner = () =>
    Promise.all([
      getRecord(database, {
        pk: key("ORG", invocation.organizationId),
        sk: key("ORG", invocation.organizationId),
      }),
      currentOwnerIsActive(database, brain),
    ]);

  if (identity.authentication === "api-credential") {
    const projectId = oneIdentityScope(identity.projectIds);
    const environmentId = oneIdentityScope(identity.environmentIds);
    const credentialId = identity.apiCredentialId;
    if (!projectId || !environmentId || !credentialId) {
      return failure(
        "forbidden",
        "brain_caller_scope_invalid",
        "The service caller scope is incomplete.",
      );
    }
    const [[organization, ownerActive], serviceAccount, credential, callerGrant] =
      await Promise.all([
        organizationAndOwner(),
        getRecord(database, {
          pk: key("ORG", invocation.organizationId, "ENV", environmentId),
          sk: key("SERVICE-ACCOUNT", identity.principalId),
        }),
        getRecord(database, {
          pk: key("ORG", invocation.organizationId, "ENV", environmentId),
          sk: key("API-CREDENTIAL", credentialId),
        }),
        repository.findActiveGrant(invocation.organizationId, brain.id, {
          environmentId,
          projectId,
          serviceAccountId: identity.principalId,
          type: "service-account",
        }),
      ]);
    const now = dependencies.now?.() ?? new Date().toISOString();
    const decision = authorizeBrainAccess({
      brain,
      caller: {
        credentialActive:
          credential?.itemType === "api-credential" &&
          credential.data.status === "active" &&
          (!credential.data.expiresAt || credential.data.expiresAt > now) &&
          credential.data.serviceAccountId === identity.principalId,
        environmentId,
        kind: "service",
        organizationId: invocation.organizationId,
        projectId,
        scopes: identity.scopes,
        serviceAccountActive:
          serviceAccount?.itemType === "service-account" &&
          serviceAccount.data.status === "active" &&
          serviceAccount.data.organizationId === invocation.organizationId &&
          serviceAccount.data.projectId === projectId &&
          serviceAccount.data.environmentId === environmentId,
        serviceAccountId: identity.principalId,
      },
      ...(callerGrant ? { callerGrant } : {}),
      operation,
      organizationActive: activeOrganization(organization, invocation.organizationId),
      ownerActive,
    });
    if (!decision.allowed) {
      return failure(
        "forbidden",
        `brain_${decision.reason.replaceAll("-", "_")}`,
        "Brain access is not authorized.",
      );
    }
    return { brain, callerGrant: callerGrant! };
  }

  const [[organization, ownerActive], principal, membership, principalGrant] = await Promise.all([
    organizationAndOwner(),
    getRecord(database, {
      pk: key("PRINCIPAL", identity.principalId),
      sk: key("PRINCIPAL", identity.principalId),
    }),
    getRecord(database, {
      pk: key("ORG", invocation.organizationId),
      sk: key("ORGANIZATION-MEMBER", identity.principalId),
    }),
    repository.findActiveGrant(invocation.organizationId, brain.id, {
      principalId: identity.principalId,
      type: "principal",
    }),
  ]);
  const organizationRole =
    membership?.itemType === "organization-member" ? membership.data.role : "viewer";
  const roleGrant = principalGrant
    ? undefined
    : canHoldBrainRoleGrant(organizationRole)
      ? await repository.findActiveGrant(invocation.organizationId, brain.id, {
          organizationRole,
          type: "organization-role",
        })
      : undefined;
  const callerGrant = principalGrant ?? roleGrant;
  const decision = authorizeBrainAccess({
    brain,
    caller: {
      kind: "human",
      membershipActive:
        membership?.itemType === "organization-member" && membership.data.status === "active",
      organizationRole,
      principalActive:
        principal?.itemType === "principal" &&
        principal.data.kind === "human" &&
        principal.data.status === "active",
      principalId: identity.principalId,
      scopes: identity.scopes,
    },
    ...(callerGrant ? { callerGrant } : {}),
    operation,
    organizationActive: activeOrganization(organization, invocation.organizationId),
    ownerActive,
  });
  if (!decision.allowed) {
    return failure(
      "forbidden",
      `brain_${decision.reason.replaceAll("-", "_")}`,
      "Brain access is not authorized.",
    );
  }
  return { brain, callerGrant: callerGrant! };
}

async function requiredBrain(repository: BrainRepository, invocation: BrainApiInvocation) {
  const brain = await repository.get(
    invocation.organizationId,
    requiredParam(invocation, "brainId"),
  );
  return brain ?? failure("not-found", "brain_not_found", "The Brain does not exist.");
}

function ownerGrant(access: Awaited<ReturnType<typeof authorize>>) {
  return access.callerGrant.permission === "owner"
    ? access.callerGrant
    : failure("forbidden", "brain_owner_required", "A live Brain owner grant is required.");
}

export function makeBrainApiService(dependencies: BrainApiServiceDependencies): BrainApiService {
  const now = () => dependencies.now?.() ?? new Date().toISOString();
  const id = () => dependencies.generateId();
  const repository = dependencies.repository;

  return {
    async invoke(routeName, invocation) {
      const knowledgeContext = () => ({
        authorize: (brain: Brain, operation: BrainOperation) =>
          authorize(dependencies, invocation, brain, operation),
        generateId: id,
        now,
        requiredBrain: () => requiredBrain(repository, invocation),
      });
      switch (routeName) {
        case "askBrains":
        case "searchBrains":
          return invokeBrainQueryRoute({
            authorizeRead: async (brain) => {
              await authorize(dependencies, invocation, brain, "read");
            },
            getBrain: (brainId) => repository.get(invocation.organizationId, brainId),
            invocation,
            routeName,
            ...(dependencies.brainQueryRuntime ? { runtime: dependencies.brainQueryRuntime } : {}),
          });

        case "createBrain": {
          if (invocation.identity.authentication === "api-credential") {
            return failure(
              "forbidden",
              "brain_human_creator_required",
              "Only a human principal may create a Brain.",
            );
          }
          const body = invocation.body as CreateBrainRequest;
          const timestamp = now();
          const [brainId, grantId, eventId] = await Promise.all([id(), id(), id()]);
          const brain: Brain = {
            createdAt: timestamp,
            createdByPrincipalId: invocation.identity.principalId,
            id: brainId,
            kind: body.kind,
            maintenancePolicy: {},
            name: body.name,
            organizationId: invocation.organizationId,
            ...(body.kind === "member-private"
              ? { ownerPrincipalId: invocation.identity.principalId }
              : {}),
            ownershipGeneration: body.kind === "member-private" ? 1 : 0,
            retrievalPolicy: {},
            schemaVersion: 1,
            sensitivity: body.sensitivity ?? "internal",
            slug: body.slug,
            status: "active",
            updatedAt: timestamp,
            updatedByPrincipalId: invocation.identity.principalId,
            version: 0,
          };
          const owner: BrainGrant = {
            brainId,
            brainKind: body.kind,
            createdAt: timestamp,
            grantedByPrincipalId: invocation.identity.principalId,
            id: grantId,
            organizationId: invocation.organizationId,
            ...(body.kind === "member-private" ? { ownershipGeneration: 1 } : {}),
            permission: "owner",
            status: "active",
            target: {
              principalId: invocation.identity.principalId,
              type: "principal",
            },
            updatedAt: timestamp,
            version: 0,
          };
          return repository.createWithOwner({
            brain,
            eventId,
            ownerGrant: owner,
          });
        }

        case "listBrains": {
          const page = await repository.listByOrganization(invocation.organizationId, {
            ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
            limit: invocation.query.limit ?? 50,
            ...(invocation.query.status ? { status: invocation.query.status } : {}),
          });
          const items: Brain[] = [];
          for (const item of page.items) {
            try {
              items.push((await authorize(dependencies, invocation, item, "read")).brain);
            } catch (cause) {
              if (!(cause instanceof PersistenceError) || cause.kind !== "forbidden") throw cause;
            }
          }
          return {
            items,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          };
        }

        case "getBrain": {
          const brain = await requiredBrain(repository, invocation);
          return (await authorize(dependencies, invocation, brain, "read")).brain;
        }

        case "recordBrainFeedback": {
          return recordBrainFeedback({
            dependencies,
            invocation,
            now,
            queryAttemptId: requiredParam(invocation, "queryAttemptId"),
          });
        }

        case "listBrainIndexHealth": {
          const brain = await requiredBrain(repository, invocation);
          await authorize(dependencies, invocation, brain, "read");
          return repository.listIndexHealth(invocation.organizationId, brain.id, {
            ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
            limit: invocation.query.limit ?? 50,
          });
        }

        case "getBrainEntity": {
          const brain = await requiredBrain(repository, invocation);
          await authorize(dependencies, invocation, brain, "read");
          const entity = await repository.getEntity(
            invocation.organizationId,
            brain.id,
            requiredParam(invocation, "entityId"),
          );
          if (!entity || entity.status !== "active" || entity.reviewStatus === "rejected") {
            return failure(
              "not-found",
              "brain_entity_not_found",
              "The Brain entity is unavailable.",
            );
          }
          const limit = Math.min(invocation.query.limit ?? 20, 50);
          const outgoing = await repository.listEntityEdges(
            invocation.organizationId,
            brain.id,
            entity.id,
            "outgoing",
            { limit },
          );
          const incoming =
            outgoing.items.length >= limit
              ? { items: [] as const }
              : await repository.listEntityEdges(
                  invocation.organizationId,
                  brain.id,
                  entity.id,
                  "incoming",
                  { limit: limit - outgoing.items.length },
                );
          await authorize(dependencies, invocation, brain, "read");
          return { edges: [...outgoing.items, ...incoming.items], entity };
        }

        case "listBrainReviewItems": {
          const brain = await requiredBrain(repository, invocation);
          await authorize(dependencies, invocation, brain, "read");
          return repository.listReviewItems(invocation.organizationId, brain.id, {
            ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
            limit: invocation.query.limit ?? 50,
            status: "open",
          });
        }

        case "resolveBrainReviewItem": {
          if (invocation.identity.authentication === "api-credential") {
            return failure(
              "forbidden",
              "brain_human_curator_required",
              "Only a human Brain curator may resolve review items.",
            );
          }
          const brain = await requiredBrain(repository, invocation);
          const access = await authorize(dependencies, invocation, brain, "write");
          const reviewItem = await repository.getReviewItem(
            invocation.organizationId,
            brain.id,
            requiredParam(invocation, "reviewItemId"),
          );
          if (!reviewItem) {
            return failure(
              "not-found",
              "brain_review_not_found",
              "The review item is unavailable.",
            );
          }
          const body = invocation.body as ResolveBrainReviewItemRequest;
          if (reviewItem.version !== body.expectedVersion || reviewItem.status !== "open") {
            return failure(
              "conflict",
              "brain_review_version_conflict",
              "The review item has changed or was already resolved.",
            );
          }
          const candidateEntityIds = Array.isArray(reviewItem.proposal.candidateEntityIds)
            ? reviewItem.proposal.candidateEntityIds.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          if (
            body.decision === "merge" &&
            (!body.targetEntityId || !candidateEntityIds.includes(body.targetEntityId))
          ) {
            return failure(
              "invalid-input",
              "brain_merge_target_required",
              "An entity merge requires a target from the proposed candidate set.",
            );
          }
          const resolvedAt = now();
          return repository.resolveReviewItem({
            actorPrincipalId: invocation.identity.principalId,
            authorizingGrant: access.callerGrant,
            brain,
            eventId: await id(),
            reviewItem: {
              ...reviewItem,
              decision: body.decision,
              ...(body.targetEntityId
                ? {
                    proposal: {
                      ...reviewItem.proposal,
                      resolutionTargetEntityId: body.targetEntityId,
                    },
                  }
                : {}),
              resolvedAt,
              resolvedByPrincipalId: invocation.identity.principalId,
              status: "resolved",
              updatedAt: resolvedAt,
              version: reviewItem.version + 1,
            },
          });
        }

        case "updateBrain":
        case "archiveBrain":
        case "eraseBrain":
        case "getBrainErasure":
          return invokeBrainLifecycleRoute({
            authorizeAdmin: async (brain, allowInactive) =>
              ownerGrant(
                await authorize(
                  dependencies,
                  invocation,
                  allowInactive ? { ...brain, status: "active" } : brain,
                  "admin",
                ),
              ),
            dependencies,
            fail: failure,
            invocation,
            now,
            requiredBrain: () => requiredBrain(repository, invocation),
            routeName,
          });

        case "listBrainGrants": {
          const brain = await requiredBrain(repository, invocation);
          await authorize(dependencies, invocation, brain, "admin");
          return repository.listGrants(invocation.organizationId, brain.id, {
            ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
            limit: invocation.query.limit ?? 50,
          });
        }

        case "createBrainGrant": {
          const brain = await requiredBrain(repository, invocation);
          const access = await authorize(dependencies, invocation, brain, "admin");
          const body = invocation.body as CreateBrainGrantRequest;
          if (
            brain.kind === "member-private" &&
            (body.target.type === "organization-role" ||
              (body.target.type === "principal" &&
                body.target.principalId !== brain.ownerPrincipalId))
          ) {
            return failure(
              "unprocessable",
              "brain_private_grant_invalid",
              "Member-private Brain delegation is restricted to its owner and named machines.",
            );
          }
          const timestamp = now();
          const grant: BrainGrant = {
            brainId: brain.id,
            brainKind: brain.kind,
            createdAt: timestamp,
            grantedByPrincipalId: invocation.identity.principalId,
            id: await id(),
            organizationId: invocation.organizationId,
            ...(brain.kind === "member-private"
              ? { ownershipGeneration: brain.ownershipGeneration }
              : {}),
            permission: body.permission,
            status: "active",
            target: body.target,
            updatedAt: timestamp,
            version: 0,
          };
          return repository.putGrant({
            authorizingGrant: ownerGrant(access),
            eventId: await id(),
            grant,
          });
        }

        case "revokeBrainGrant": {
          const brain = await requiredBrain(repository, invocation);
          const access = await authorize(dependencies, invocation, brain, "admin");
          const grant = await repository.getGrant(
            invocation.organizationId,
            brain.id,
            requiredParam(invocation, "grantId"),
          );
          if (!grant)
            return failure("not-found", "brain_grant_not_found", "The Brain grant does not exist.");
          if (grant.version !== expectedVersion(invocation.body)) {
            return failure(
              "conflict",
              "brain_grant_version_conflict",
              "The Brain grant version has changed.",
            );
          }
          let replacementOwnerGrant: BrainGrant | undefined;
          if (grant.permission === "owner" && brain.kind === "company") {
            const page = await repository.listGrants(invocation.organizationId, brain.id, {
              limit: 100,
            });
            replacementOwnerGrant = page.items.find(
              (candidate) =>
                candidate.id !== grant.id &&
                candidate.status === "active" &&
                candidate.permission === "owner" &&
                candidate.target.type === "principal",
            );
          }
          return repository.revokeGrant({
            actorPrincipalId: invocation.identity.principalId,
            authorizingGrant: ownerGrant(access),
            eventId: await id(),
            grant,
            ...(replacementOwnerGrant ? { replacementOwnerGrant } : {}),
            revokedAt: now(),
          });
        }

        case "listBrainMounts": {
          const brain = await requiredBrain(repository, invocation);
          await authorize(dependencies, invocation, brain, "admin");
          return repository.listMounts(invocation.organizationId, brain.id, {
            ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
            limit: invocation.query.limit ?? 50,
          });
        }

        case "createBrainMount": {
          const brain = await requiredBrain(repository, invocation);
          const access = await authorize(dependencies, invocation, brain, "admin");
          const body = invocation.body as CreateBrainMountRequest;
          const agentGrant = await repository.findActiveGrant(invocation.organizationId, brain.id, {
            agentDefinitionId: body.agentDefinitionId,
            environmentId: body.environmentId,
            projectId: body.projectId,
            type: "agent-definition",
          });
          if (!agentGrant) {
            return failure(
              "unprocessable",
              "brain_agent_grant_required",
              "The agent definition needs an active Brain grant before it can be mounted.",
            );
          }
          const timestamp = now();
          return repository.putMount({
            agentDefinitionGrant: agentGrant,
            authorizingGrant: ownerGrant(access),
            eventId: await id(),
            mount: {
              ...body,
              brainId: brain.id,
              brainKind: brain.kind,
              createdAt: timestamp,
              grantedByPrincipalId: invocation.identity.principalId,
              id: await id(),
              organizationId: invocation.organizationId,
              ...(brain.kind === "member-private"
                ? { ownershipGeneration: brain.ownershipGeneration }
                : {}),
              status: "active",
              updatedAt: timestamp,
              version: 0,
            },
          });
        }

        case "revokeBrainMount": {
          const brain = await requiredBrain(repository, invocation);
          const access = await authorize(dependencies, invocation, brain, "admin");
          const mount = await repository.getMount(
            invocation.organizationId,
            brain.id,
            requiredParam(invocation, "mountId"),
          );
          if (!mount)
            return failure("not-found", "brain_mount_not_found", "The Brain mount does not exist.");
          if (mount.version !== expectedVersion(invocation.body)) {
            return failure(
              "conflict",
              "brain_mount_version_conflict",
              "The Brain mount version has changed.",
            );
          }
          return repository.revokeMount({
            actorPrincipalId: invocation.identity.principalId,
            authorizingGrant: ownerGrant(access),
            eventId: await id(),
            mount,
            revokedAt: now(),
          });
        }

        case "captureBrainDocument":
        case "createBrainSource":
        case "getBrainDocument":
        case "listBrainSources":
          return invokeBrainKnowledgeRoute(dependencies, routeName, invocation, knowledgeContext());

        case "completeBrainUpload":
        case "createBrainUploadTicket":
        case "getBrainUploadTicket":
        case "uploadBrainContent":
          return invokeBrainUploadRoute(dependencies, routeName, invocation, knowledgeContext());
      }
    },
  };
}
