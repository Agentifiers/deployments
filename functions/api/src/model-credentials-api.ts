import { createHmac, randomUUID } from "node:crypto";
import {
  MODEL_CREDENTIAL_API_ROUTES,
  ModelCredentialProvider,
  PUBLIC_ID_PATTERN,
  PutModelCredentialRequest,
  decodePublicResponse,
} from "@deployments-ai/api-contract";
import {
  ByokProvider,
  PersistenceError,
  Ulid,
  makeKmsEnvelopeAdapter,
  makeModelProviderCredentialPersistence,
  organizationRoleAllows,
  organizationRolesAllowing,
  type DynamoDatabaseService,
  type IdempotencyPersistence,
  type ModelProviderCredentialChange,
  type ModelProviderCredentialPersistence,
} from "@deployments-ai/db";
import { Option, Schema } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { errorLogFields } from "./error-log-fields.ts";
import { requiredEnvironment } from "./lambda-environment.ts";
import {
  ModelProviderUnavailableError,
  makeModelKeyProbe,
  type ModelKeyProbe,
} from "./model-credential-probe.ts";
import { persistenceStatus } from "./persistence-error-status.ts";
import { routePattern } from "./route-request-parsing.ts";
import { permits } from "./scope-permissions.ts";

export const MODEL_CREDENTIALS_ENV = {
  kmsKeyArn: "DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN",
  providers: "DEPLOYMENTS_AI_MODEL_CREDENTIAL_PROVIDERS",
  stage: "DEPLOYMENTS_AI_STAGE",
} as const;

/** What an install with bring-your-own model keys enabled serves; absent when none are enabled. */
export interface ModelCredentialStore {
  readonly credentials: ModelProviderCredentialPersistence;
  readonly probe: ModelKeyProbe;
  readonly providers: ReadonlySet<ByokProvider>;
}

export interface CreateModelCredentialsApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly idempotency: Pick<IdempotencyPersistence, "execute">;
  readonly requestId?: () => string;
  readonly store?: ModelCredentialStore;
}

class ModelCredentialProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelCredentialProblem";
  }
}

const matchers = MODEL_CREDENTIAL_API_ROUTES.map((route) => ({
  route,
  ...routePattern(route.path),
}));

const decodeUlid = Schema.decodeUnknownOption(Ulid);
const decodeProvider = Schema.decodeUnknownOption(ModelCredentialProvider);

function problem(status: number, code: string, detail: string, requestId: string) {
  return Response.json(
    {
      code,
      detail,
      requestId,
      status,
      title: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Request failed",
    },
    {
      headers: { "content-type": "application/problem+json", "x-request-id": requestId },
      status,
    },
  );
}

function errorResponse(cause: unknown, requestId: string) {
  if (cause instanceof ModelCredentialProblem)
    return problem(cause.status, cause.code, cause.message, requestId);
  if (cause instanceof PersistenceError) {
    return problem(persistenceStatus(cause), cause.code, cause.message, requestId);
  }
  if (cause instanceof ModelProviderUnavailableError) {
    return problem(502, "model_provider_unavailable", cause.message, requestId);
  }
  if (cause instanceof Schema.SchemaError || cause instanceof SyntaxError) {
    return problem(
      422,
      "validation_failed",
      "The request did not match the API contract.",
      requestId,
    );
  }
  if (cause instanceof URIError) {
    return problem(400, "invalid_path_parameter", "A path parameter is malformed.", requestId);
  }
  return problem(500, "internal_error", "The model credential request failed.", requestId);
}

function organizationFor(request: Request, identity: ApiIdentity, rawOrganizationId: string) {
  const organizationId = decodeUlid(decodeURIComponent(rawOrganizationId));
  if (Option.isNone(organizationId)) {
    throw new ModelCredentialProblem(
      404,
      "organization_not_found",
      "The organization was not found.",
    );
  }
  const header = request.headers.get("x-deployments-organization")?.trim();
  if (!header) {
    throw new ModelCredentialProblem(
      400,
      "missing_organization_context",
      "x-deployments-organization is required.",
    );
  }
  if (!PUBLIC_ID_PATTERN.test(header) || header !== organizationId.value) {
    throw new ModelCredentialProblem(
      403,
      "organization_scope_violation",
      "The organization scope header must match the organization path.",
    );
  }
  const granted = identity.organizationIds;
  if (granted !== "*" && !granted?.includes(organizationId.value)) {
    throw new ModelCredentialProblem(
      403,
      "organization_scope_violation",
      "The credential cannot access the requested organization.",
    );
  }
  return organizationId.value;
}

function notEnabled(provider?: string) {
  return new ModelCredentialProblem(
    404,
    "model_credentials_not_enabled",
    provider
      ? `Bring-your-own model keys are not enabled for ${provider} on this installation.`
      : "Bring-your-own model keys are not enabled on this installation.",
  );
}

function enabledProvider(store: ModelCredentialStore, rawProvider: string) {
  const provider = Option.getOrThrowWith(decodeProvider(decodeURIComponent(rawProvider)), () =>
    notEnabled(),
  );
  if (!store.providers.has(provider)) throw notEnabled(provider);
  return provider;
}

function credentialNotFound(provider: ByokProvider) {
  return new ModelCredentialProblem(
    404,
    "model_credential_not_found",
    `The organization has no ${provider} key.`,
  );
}

async function providerOperation(
  store: ModelCredentialStore,
  name: "deleteModelCredential" | "getModelCredential" | "putModelCredential",
  change: ModelProviderCredentialChange,
  body: string,
) {
  switch (name) {
    case "getModelCredential": {
      const summary = await store.credentials.get(change.organizationId, change.provider);
      if (!summary) throw credentialNotFound(change.provider);
      return summary;
    }
    case "deleteModelCredential": {
      const summary = await store.credentials.remove(change);
      if (!summary) throw credentialNotFound(change.provider);
      return summary;
    }
    case "putModelCredential": {
      const input = Schema.decodeUnknownSync(PutModelCredentialRequest, {
        onExcessProperty: "error",
      })(JSON.parse(body || "null"));
      if ((await store.probe(change.provider, input.apiKey)) === "rejected") {
        throw new ModelCredentialProblem(
          422,
          "model_credential_rejected",
          `The ${change.provider} API rejected the key, so it was not stored.`,
        );
      }
      return store.credentials.set({ ...change, ...input });
    }
  }
}

export function createModelCredentialsApi(options: CreateModelCredentialsApiOptions) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const matcher = matchers.find(
      (candidate) => candidate.route.method === method && candidate.pattern.test(url.pathname),
    );
    if (!matcher) return undefined;
    const { route } = matcher;
    const requestId = options.requestId?.() ?? randomUUID();
    try {
      const identity = await options.authenticate(request);
      if (!identity) {
        return problem(401, "unauthorized", "A valid bearer credential is required.", requestId);
      }
      const [rawOrganizationId = "", rawProvider] = matcher.pattern.exec(url.pathname)!.slice(1);
      const organizationId = organizationFor(request, identity, rawOrganizationId);
      if (!permits(identity.scopes, route.requiredAuthorization)) {
        throw new ModelCredentialProblem(
          403,
          "insufficient_scope",
          `The credential does not have the required ${route.requiredAuthorization} capability.`,
        );
      }
      if (!organizationRoleAllows(identity.organizationRole, "model-credentials.manage")) {
        throw new ModelCredentialProblem(
          403,
          "insufficient_role",
          `Model provider keys require one of these organization roles: ${organizationRolesAllowing("model-credentials.manage").join(", ")}.`,
        );
      }
      const actorPrincipalId = Option.getOrThrowWith(
        decodeUlid(identity.principalId),
        () =>
          new ModelCredentialProblem(
            403,
            "insufficient_role",
            "Only organization members manage model keys.",
          ),
      );
      const { store } = options;
      if (!store) throw notEnabled();
      const target =
        route.name === "listModelCredentials"
          ? undefined
          : {
              change: {
                actorPrincipalId,
                organizationId,
                provider: enabledProvider(store, rawProvider ?? ""),
              },
              name: route.name,
            };
      const body = method === "PUT" ? await request.text() : "";
      const operation = async () => {
        const result = target
          ? await providerOperation(store, target.name, target.change, body)
          : {
              items: (await store.credentials.list(organizationId)).filter((item) =>
                store.providers.has(item.provider),
              ),
            };
        try {
          return decodePublicResponse(route.name, result);
        } catch (cause) {
          throw new Error("A model credential response broke its contract.", { cause });
        }
      };

      if (route.idempotency === "none") {
        return Response.json(await operation(), {
          headers: { "x-request-id": requestId },
          status: route.successStatus,
        });
      }
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey) {
        return problem(400, "missing_idempotency_key", "Idempotency-Key is required.", requestId);
      }
      const result = await options.idempotency.execute({
        fingerprint: createHmac("sha256", JSON.stringify([identity.principalId, idempotencyKey]))
          .update(JSON.stringify({ body, method, organizationId, path: url.pathname }))
          .digest("hex"),
        key: `${organizationId}:${idempotencyKey}`,
        operation,
        organizationId,
        principalId: identity.principalId,
      });
      return Response.json(result, {
        headers: { "x-request-id": requestId },
        status: route.successStatus,
      });
    } catch (cause) {
      const response = errorResponse(cause, requestId);
      if (response.status === 500) {
        console.error("Model credential API request failed.", {
          ...errorLogFields(cause),
          requestId,
          route: route.name,
        });
      }
      return response;
    }
  };
}

function parseProviders(raw: string | undefined): ReadonlySet<ByokProvider> {
  const names = (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return new Set(
    names.map((name) =>
      Option.getOrThrowWith(
        Schema.decodeUnknownOption(ByokProvider)(name),
        () => new Error(`${MODEL_CREDENTIALS_ENV.providers} names unknown provider ${name}.`),
      ),
    ),
  );
}

export function modelCredentialsApiFromEnvironment(input: {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly database: DynamoDatabaseService;
  readonly environment: NodeJS.ProcessEnv;
  readonly idempotency: Pick<IdempotencyPersistence, "execute">;
}) {
  const providers = parseProviders(input.environment[MODEL_CREDENTIALS_ENV.providers]);
  return createModelCredentialsApi({
    authenticate: input.authenticate,
    idempotency: input.idempotency,
    ...(providers.size === 0
      ? {}
      : {
          store: {
            credentials: makeModelProviderCredentialPersistence({
              database: input.database,
              envelope: makeKmsEnvelopeAdapter({
                keyId: requiredEnvironment(input.environment, MODEL_CREDENTIALS_ENV.kmsKeyArn),
                stage: requiredEnvironment(input.environment, MODEL_CREDENTIALS_ENV.stage),
              }),
            }),
            probe: makeModelKeyProbe(),
            providers,
          },
        }),
  });
}
