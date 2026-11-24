import { key } from "./keys.ts";
import { PersistenceError } from "./persistence-types.ts";
import type { Environment, TenancyContext, TenancyPersistence } from "./tenancy.ts";
import {
  assertCollectionGrant,
  assertPathScope,
  createOperations,
  environmentResult,
  id,
  mutableRecord,
  requiredResourceId,
  requiredScope,
  resolveSlug,
  updateOperations,
  updatedRecord,
} from "./tenancy.ts";

export function makeEnvironmentPersistence(
  context: TenancyContext & Pick<TenancyPersistence, "projects">,
) {
  const { generateId, now, listRecords, projectFor, environmentFor, write } = context;
  const service: TenancyPersistence["environments"] = {
    async list(invocation) {
      assertCollectionGrant(invocation.identity.environmentIds, "environment");
      const project = await projectFor(invocation, requiredScope(invocation, "projectId"));
      const page = await listRecords<Environment>(
        invocation,
        key("ORG", project.data.organizationId, "PROJECT", project.data.id),
        "environment",
      );
      return {
        items: page.items.map((record) => environmentResult(record.data)),
        nextCursor: page.nextCursor,
      };
    },
    async create(invocation) {
      assertCollectionGrant(invocation.identity.environmentIds, "environment");
      const project = await projectFor(invocation, requiredScope(invocation, "projectId"));
      if (project.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "project_archived",
          "Archived projects cannot accept new environments.",
        );
      }
      const timestamp = now().toISOString();
      const slug = String(
        resolveSlug({
          name: invocation.body.name,
          ...(invocation.body.slug ? { slug: invocation.body.slug } : {}),
        }),
      );
      const record = mutableRecord("environment", {
        createdAt: timestamp,
        id: id(await generateId()),
        kind: invocation.body.type,
        name: invocation.body.name,
        organizationId: project.data.organizationId,
        projectId: project.data.id,
        slug,
        status: "active",
        updatedAt: timestamp,
        version: 1,
      });
      await write(
        invocation,
        "environment.create",
        createOperations(record, timestamp),
        record,
        "environment.created",
        timestamp,
        { code: "resource_conflict", message: "Environment slug is already in use." },
      );
      return environmentResult(record.data);
    },
    async get(invocation) {
      const resourceId = requiredResourceId(invocation);
      assertPathScope(invocation, "environmentId", resourceId);
      const record = await environmentFor(invocation, resourceId);
      return environmentResult(record.data);
    },
    async update(invocation) {
      const resourceId = requiredResourceId(invocation);
      assertPathScope(invocation, "environmentId", resourceId);
      const previous = await environmentFor(invocation, resourceId);
      const timestamp = now().toISOString();
      const slug = invocation.body.slug
        ? String(
            resolveSlug({
              name: invocation.body.name ?? previous.data.name,
              slug: invocation.body.slug,
            }),
          )
        : previous.data.slug;
      const next = updatedRecord(previous, timestamp, {
        ...(invocation.body.name !== undefined ? { name: invocation.body.name } : {}),
        slug,
      });
      await write(
        invocation,
        "environment.update",
        updateOperations(previous, next, timestamp),
        next,
        "environment.updated",
        timestamp,
        {
          code: "resource_conflict",
          message: "The environment changed or its slug is already in use.",
        },
      );
      return environmentResult(next.data);
    },
    async archive(invocation) {
      const resourceId = requiredResourceId(invocation);
      assertPathScope(invocation, "environmentId", resourceId);
      const previous = await environmentFor(invocation, resourceId);
      if (previous.data.status === "archived") return environmentResult(previous.data);
      const timestamp = now().toISOString();
      const next = updatedRecord(previous, timestamp, { status: "archived" });
      await write(
        invocation,
        "environment.archive",
        [{ kind: "put", previousRecord: previous, record: next }],
        next,
        "environment.archived",
        timestamp,
        { code: "version_conflict", message: "The environment changed concurrently." },
      );
      return environmentResult(next.data);
    },
  };
  return service;
}
