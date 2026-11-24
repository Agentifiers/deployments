import { Schema } from "effect";
import {
  makeAgentDefinitionReleaseIndexRecord,
  makeAgentReleaseControlRecord,
} from "./agent-lifecycle-storage.ts";
import type {
  AgentDefinition,
  AgentEnvironmentScope,
  AgentLifecycleContext,
  AgentLifecyclePersistence,
  AgentRelease,
} from "./agent-lifecycle-types.ts";
import {
  agentReleaseResult,
  databaseValue,
  databaseWriteAttempt,
  definitionRecord,
  id,
  uniqueClaim,
  updatedDefinition,
  validationMessage,
} from "./agent-lifecycle.ts";
import { type TransactionOperation, type UniqueClaimRecord } from "./client-types.ts";
import { assertClientToolTriggers } from "./client-tool-trigger-validation.ts";
import { snapshotPromotedReleaseHostedCodeTools } from "./hosted-code/release-pins.ts";
import { key } from "./keys.ts";
import { PersistenceError, type PersistenceInvocation } from "./persistence-types.ts";
import { AgentDefinitionRecord, AgentReleaseRecord } from "./records/control.ts";
import { tableForItemType, withCanonicalRecordKeys } from "./records/index.ts";
import { transactWithSemanticEvents } from "./semantic-event-storage.ts";
import { makePersistenceTransactionToken } from "./transaction-conditions.ts";
import {
  acquireUniqueClaim,
  agentDefinitionSlugClaimNamespace,
  makeUniqueClaimRecord,
  promotedAgentReleaseClaimNamespace,
  uniqueClaimRequirements,
} from "./unique-claims.ts";

const MAX_PROMOTION_ATTEMPTS = 3;

type Promote = AgentLifecyclePersistence["agentReleases"]["promote"];

/**
 * Copies one immutable release into another environment of the same project. The target
 * definition is matched by slug; its draft, deployments, credentials, and runtime config are
 * never touched. Idempotency is enforced by a content-hash uniqueness claim per definition.
 */
export function makeAgentReleasePromotion(context: AgentLifecycleContext): Promote {
  const {
    allPartitionRecords,
    dependencies,
    environmentFor,
    generateId,
    getAgentRecord,
    lastReleaseNumber,
    lifecycleEvent,
    now,
    recordStore,
  } = context;

  async function targetEnvironment(
    invocation: PersistenceInvocation,
    source: AgentEnvironmentScope,
    targetEnvironmentId: string,
  ) {
    if (targetEnvironmentId === String(source.id)) {
      throw new PersistenceError(
        "invalid-input",
        "same_environment_promotion",
        "Promotion requires a different target environment.",
      );
    }
    let target: AgentEnvironmentScope | undefined;
    try {
      target = await dependencies.resolveEnvironment({
        ...invocation,
        body: undefined,
        scope: { environmentId: targetEnvironmentId },
      });
    } catch (cause) {
      if (!(cause instanceof PersistenceError) || cause.kind !== "not-found") throw cause;
    }
    if (!target || String(target.id) !== targetEnvironmentId) {
      throw new PersistenceError(
        "not-found",
        "target_environment_not_found",
        "The target environment was not found.",
      );
    }
    if (
      String(target.organizationId) !== String(source.organizationId) ||
      String(target.projectId) !== String(source.projectId)
    ) {
      throw new PersistenceError(
        "unprocessable",
        "cross_project_promotion",
        "Releases can only be promoted between environments of the same project.",
      );
    }
    return target;
  }

  async function claimOwner(namespace: string, value: string) {
    const claim = await databaseValue(
      dependencies.database.getRecord(
        tableForItemType("unique-claim"),
        { pk: key("UNIQUE", namespace), sk: key("VALUE", value) },
        true,
      ),
    );
    return claim?.itemType === "unique-claim" ? claim.data : undefined;
  }

  async function environmentRecord<T extends AgentDefinition | AgentRelease>(
    target: AgentEnvironmentScope,
    itemType: T["itemType"],
    resourceId: string,
  ) {
    const record = await databaseValue(
      recordStore.getEnvironmentRecord(
        { environmentId: target.id, organizationId: target.organizationId },
        itemType,
        resourceId,
      ),
    );
    return record?.itemType === itemType ? (record as T) : undefined;
  }

  async function targetDefinition(target: AgentEnvironmentScope, slug: string) {
    const claim = await claimOwner(
      agentDefinitionSlugClaimNamespace(target.id),
      slug.toLowerCase(),
    );
    if (!claim) return undefined;
    const definition =
      claim.ownerItemType === "agent-definition"
        ? await environmentRecord<AgentDefinition>(target, "agent-definition", claim.ownerId)
        : undefined;
    if (!definition) {
      throw new PersistenceError(
        "conflict",
        "definition_slug_conflict",
        "The target environment slug is claimed by another resource.",
      );
    }
    if (definition.data.status !== "active") {
      throw new PersistenceError(
        "conflict",
        "target_definition_archived",
        "The matching agent definition in the target environment is archived.",
      );
    }
    return definition;
  }

  async function existingRelease(
    target: AgentEnvironmentScope,
    definition: AgentDefinition,
    contentHash: string,
  ) {
    const claim = await claimOwner(
      promotedAgentReleaseClaimNamespace(target.id, definition.data.id),
      contentHash,
    );
    const claimed = claim
      ? await environmentRecord<AgentRelease>(target, "agent-release", claim.ownerId)
      : undefined;
    if (claimed?.data.status === "active") return claimed;
    if (claimed) {
      throw new PersistenceError(
        "conflict",
        "target_release_archived",
        "The promoted release in the target environment has been archived.",
      );
    }
    const releases = await allPartitionRecords<AgentRelease>(
      { id: target.id, organizationId: target.organizationId },
      "agent-release",
    );
    return releases.find(
      (release) =>
        release.data.agentDefinitionId === definition.data.id &&
        release.data.contentHash === contentHash &&
        release.data.status === "active",
    );
  }

  return async function promote(invocation) {
    const source = await getAgentRecord<AgentRelease>(invocation, "agent-release", "Agent release");
    if (source.data.status !== "active") {
      throw new PersistenceError(
        "conflict",
        "source_release_archived",
        "Archived releases cannot be promoted.",
      );
    }
    const sourceEnvironment = await environmentFor(invocation);
    const sourceDefinition = await getAgentRecord<AgentDefinition>(
      { ...invocation, id: source.data.agentDefinitionId },
      "agent-definition",
      "Agent definition",
    );
    if (sourceDefinition.data.workspaceId) {
      throw new PersistenceError(
        "unprocessable",
        "workspace_scoped_definition",
        "Workspace-scoped agent definitions cannot be promoted between environments.",
      );
    }
    const target = await targetEnvironment(
      invocation,
      sourceEnvironment,
      invocation.body.targetEnvironmentId,
    );
    const targetScope = {
      environmentId: target.id,
      organizationId: target.organizationId,
      projectId: target.projectId,
    };
    // The promoted release must be admissible under the target environment's own client-tool
    // extensions and model policy, exactly as if it had been published there. A target definition
    // that already exists selects its agent-scoped model grants; a new one has none yet.
    await assertClientToolTriggers(dependencies.database, targetScope, source.data.manifest);
    const admittedDefinition = await targetDefinition(target, sourceDefinition.data.slug);
    await context.assertManifestAdmitted({
      manifest: source.data.manifest,
      scope: {
        ...targetScope,
        ...(admittedDefinition ? { agentDefinitionId: admittedDefinition.data.id } : {}),
      },
    });
    const principalId = id(invocation.identity.principalId);
    const targetInvocation = { ...invocation, scope: { environmentId: target.id } };
    for (let attempt = 0; attempt < MAX_PROMOTION_ATTEMPTS; attempt += 1) {
      const existingDefinition = await targetDefinition(target, sourceDefinition.data.slug);
      if (existingDefinition) {
        const existing = await existingRelease(target, existingDefinition, source.data.contentHash);
        if (existing) return { created: false, release: agentReleaseResult(existing.data) };
      }
      const timestamp = now().toISOString();
      const definition =
        existingDefinition ??
        definitionRecord({
          environment: target,
          manifest: source.data.manifest,
          principalId,
          resourceId: id(await generateId()),
          timestamp,
        });
      const releaseNumber = existingDefinition ? (await lastReleaseNumber(definition)) + 1 : 1;
      const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
        withCanonicalRecordKeys({
          data: {
            agentDefinitionId: definition.data.id,
            contentHash: source.data.contentHash,
            createdAt: timestamp,
            createdByPrincipalId: principalId,
            environmentId: id(target.id),
            id: id(await generateId()),
            manifest: structuredClone(source.data.manifest),
            organizationId: id(target.organizationId),
            projectId: id(target.projectId),
            promotedFromEnvironmentId: source.data.environmentId,
            promotedFromReleaseId: source.data.id,
            releaseNumber,
            status: "active" as const,
            version: 0,
          },
          itemType: "agent-release" as const,
        }),
      );
      const [releaseClaim] = uniqueClaimRequirements(release);
      if (!releaseClaim) {
        throw new PersistenceError(
          "internal",
          "persistence_error",
          "Promoted release uniqueness is not registered.",
        );
      }
      const hostedCode = await databaseValue(
        snapshotPromotedReleaseHostedCodeTools(dependencies.database, {
          agentReleaseId: release.data.id,
          createdAt: timestamp,
          environmentId: release.data.environmentId,
          manifest: release.data.manifest,
          organizationId: release.data.organizationId,
          projectId: release.data.projectId,
          sourceAgentReleaseId: source.data.id,
        }),
      );
      if (hostedCode.issues.length > 0) {
        const codes = new Set(hostedCode.issues.map((issue) => issue.code));
        throw new PersistenceError(
          "unprocessable",
          codes.has("hosted_code_tool_unavailable")
            ? "hosted_code_tool_unavailable"
            : codes.has("hosted_code_tool_mismatch")
              ? "hosted_code_tool_mismatch"
              : "invalid_agent_manifest",
          validationMessage(hostedCode.issues),
        );
      }
      const nextDefinition = existingDefinition
        ? updatedDefinition(existingDefinition, timestamp, { lastReleaseNumber: releaseNumber })
        : Schema.decodeUnknownSync(AgentDefinitionRecord)({
            ...definition,
            data: { ...definition.data, lastReleaseNumber: releaseNumber },
          });
      const operations: TransactionOperation[] = existingDefinition
        ? [{ kind: "put", previousRecord: existingDefinition, record: nextDefinition }]
        : [
            { kind: "put", record: nextDefinition },
            {
              kind: "put",
              record: makeAgentDefinitionReleaseIndexRecord(nextDefinition, timestamp),
            },
            acquireUniqueClaim(uniqueClaim(nextDefinition, timestamp)),
          ];
      operations.push(
        { kind: "put", record: release },
        { kind: "put", record: makeAgentReleaseControlRecord(release, timestamp, 0) },
        acquireUniqueClaim(makeUniqueClaimRecord(releaseClaim, timestamp) as UniqueClaimRecord),
        ...hostedCode.pins.map((record) => ({ kind: "put" as const, record })),
      );
      // One semantic event per aggregate per transaction: a new target definition records its
      // creation (with the promoted release), an existing one records the published release.
      const events = [
        await lifecycleEvent(targetInvocation, {
          aggregateId: nextDefinition.data.id,
          aggregateType: "agent-definition",
          ...(existingDefinition ? {} : { aggregateVersion: 1 }),
          environmentId: nextDefinition.data.environmentId,
          eventType: existingDefinition
            ? "agent-definition.release-published"
            : "agent-definition.created",
          occurredAt: timestamp,
          organizationId: nextDefinition.data.organizationId,
          payload: {
            agentReleaseId: release.data.id,
            id: nextDefinition.data.id,
            releaseNumber,
            slug: nextDefinition.data.slug,
            status: nextDefinition.data.status,
          },
          projectId: nextDefinition.data.projectId,
        }),
        await lifecycleEvent(targetInvocation, {
          aggregateId: release.data.id,
          aggregateType: "agent-release",
          aggregateVersion: 1,
          environmentId: release.data.environmentId,
          eventType: "agent-release.published",
          occurredAt: timestamp,
          organizationId: release.data.organizationId,
          payload: {
            agentDefinitionId: release.data.agentDefinitionId,
            contentHash: release.data.contentHash,
            id: release.data.id,
            releaseNumber,
            sourceEnvironmentId: source.data.environmentId,
            sourceReleaseId: source.data.id,
            status: release.data.status,
          },
          projectId: release.data.projectId,
        }),
      ];
      const committed = await databaseWriteAttempt(
        transactWithSemanticEvents(
          dependencies.database,
          operations,
          events,
          makePersistenceTransactionToken(invocation, "agent-release.promote", attempt),
        ),
      );
      if (committed) return { created: true, release: agentReleaseResult(release.data) };
    }
    throw new PersistenceError(
      "conflict",
      "version_conflict",
      "The target environment changed repeatedly while promoting the release.",
    );
  };
}
