import {
  MODEL_API_ROUTES,
  type ArchiveModelPolicyRequest,
  type CreateModelPolicyRequest,
  type ModelApiRouteName,
  type UpdateModelPolicyRequest,
} from "@deployments-ai/api-contract";
import {
  PersistenceError,
  makeModelCatalogPersistence,
  makeModelPolicyPersistence,
  type DynamoDatabaseService,
  type LoadModelOperatorGrants,
  type ModelPolicyData,
  type ModelPolicyScope,
} from "@deployments-ai/db";
import {
  agentModelGrantScope,
  catalogLookupModelIds,
  effectiveModelPolicy,
  modelPolicyRuleIssues,
  type ModelPolicyRules,
} from "@deployments-ai/model-gateway";
import type { AdministrationInvocation } from "./administration-api.ts";
import type { AdministrationEnvironment } from "./administration-persistence-contracts.ts";
import { modelCatalogPage } from "./model-catalog-listing.ts";

const MODEL_ROUTE_NAMES = new Set<string>(MODEL_API_ROUTES.map((route) => route.name));
const DEFAULT_PAGE_SIZE = 50;

export function isModelApiRouteName(routeName: string): routeName is ModelApiRouteName {
  return MODEL_ROUTE_NAMES.has(routeName);
}

export interface ModelAdministrationDependencies {
  readonly database: DynamoDatabaseService;
  /** Resolves the request's active environment or throws the administration environment error. */
  readonly environment: (
    invocation: AdministrationInvocation,
  ) => Promise<AdministrationEnvironment>;
  readonly generateId?: () => Promise<string>;
  /** The operator grants publish admits with, so listed `allowed` flags agree with publish. */
  readonly loadModelOperatorGrants?: LoadModelOperatorGrants;
  readonly now?: () => Date;
}

/** The public projection; the dispatcher decodes it against ModelPolicyResponse. */
function policyResponse(policy: ModelPolicyData) {
  return {
    ...(policy.archivedAt === undefined ? {} : { archivedAt: policy.archivedAt }),
    createdAt: policy.createdAt,
    ...(policy.description === undefined ? {} : { description: policy.description }),
    id: policy.id,
    includeCuratedModels: policy.includeCuratedModels,
    models: policy.models,
    name: policy.name,
    status: policy.status,
    updatedAt: policy.updatedAt,
    version: policy.version,
  };
}

function requiredId(invocation: AdministrationInvocation) {
  if (!invocation.id) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_path_parameter",
      "A model policy id is required.",
    );
  }
  return invocation.id;
}

function mutationContext(invocation: AdministrationInvocation) {
  if (!invocation.identity) {
    throw new PersistenceError("forbidden", "unauthorized", "A principal is required.");
  }
  return { principalId: invocation.identity.principalId };
}

export function makeModelAdministration(dependencies: ModelAdministrationDependencies) {
  const policies = makeModelPolicyPersistence(dependencies.database, {
    ...(dependencies.generateId ? { generateId: dependencies.generateId } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const catalog = makeModelCatalogPersistence(dependencies.database);

  async function scopeFor(invocation: AdministrationInvocation): Promise<ModelPolicyScope> {
    const environment = await dependencies.environment(invocation);
    return {
      environmentId: environment.id,
      organizationId: environment.organizationId,
      projectId: environment.projectId,
    };
  }

  /** Rejects rules with unparseable, repeated, or uncatalogued entries (422 invalid_model_policy). */
  async function assertValidRules(rules: ModelPolicyRules) {
    const entries = await catalog.getEntries(
      catalogLookupModelIds(rules.models.filter((entry) => !entry.endsWith("/*"))),
    );
    const issues = modelPolicyRuleIssues(rules, {
      has: (modelId) => entries.get(modelId)?.status === "active",
    });
    if (issues.length > 0) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_model_policy",
        issues
          .map((issue) => (issue.entry ? `${issue.entry}: ${issue.message}` : issue.message))
          .join("\n"),
      );
    }
  }

  return {
    async invoke(routeName: ModelApiRouteName, invocation: AdministrationInvocation) {
      const scope = await scopeFor(invocation);
      switch (routeName) {
        case "listModels": {
          const [active, entries, grants] = await Promise.all([
            policies.getActive(scope),
            catalog.listEntries(),
            dependencies.loadModelOperatorGrants ? dependencies.loadModelOperatorGrants() : [],
          ]);
          return {
            ...modelCatalogPage({
              ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
              entries,
              filters: invocation.query.modelFilters ?? {},
              limit: invocation.query.limit ?? DEFAULT_PAGE_SIZE,
              ...(grants.length > 0
                ? {
                    operatorGrants: {
                      grants,
                      scope: agentModelGrantScope({ organizationId: scope.organizationId }),
                    },
                  }
                : {}),
              policy: effectiveModelPolicy(active),
            }),
            policy: active
              ? { modelPolicyId: active.id, source: "model_policy" as const }
              : { source: "curated_defaults" as const },
          };
        }
        case "listModelPolicies": {
          const page = await policies.list(scope, {
            ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
            limit: invocation.query.limit ?? DEFAULT_PAGE_SIZE,
          });
          return { items: page.items.map(policyResponse), nextCursor: page.nextCursor };
        }
        case "getModelPolicy":
          return policyResponse(await policies.get(scope, requiredId(invocation)));
        case "createModelPolicy": {
          const body = invocation.body as CreateModelPolicyRequest;
          const context = mutationContext(invocation);
          await assertValidRules(body);
          return policyResponse(
            await policies.create(
              scope,
              {
                ...(body.description === undefined ? {} : { description: body.description }),
                includeCuratedModels: body.includeCuratedModels,
                models: body.models,
                name: body.name,
              },
              context,
            ),
          );
        }
        case "updateModelPolicy": {
          const body = invocation.body as UpdateModelPolicyRequest;
          const context = mutationContext(invocation);
          const id = requiredId(invocation);
          if (body.includeCuratedModels !== undefined || body.models !== undefined) {
            const previous = await policies.get(scope, id);
            await assertValidRules({
              includeCuratedModels: body.includeCuratedModels ?? previous.includeCuratedModels,
              models: body.models ?? previous.models,
            });
          }
          return policyResponse(
            await policies.update(
              scope,
              id,
              {
                ...(body.description === undefined ? {} : { description: body.description }),
                expectedVersion: body.expectedVersion,
                ...(body.includeCuratedModels === undefined
                  ? {}
                  : { includeCuratedModels: body.includeCuratedModels }),
                ...(body.models === undefined ? {} : { models: body.models }),
                ...(body.name === undefined ? {} : { name: body.name }),
              },
              context,
            ),
          );
        }
        case "archiveModelPolicy": {
          const body = invocation.body as ArchiveModelPolicyRequest;
          return policyResponse(
            await policies.archive(
              scope,
              requiredId(invocation),
              body.expectedVersion,
              mutationContext(invocation),
            ),
          );
        }
      }
    },
  };
}
