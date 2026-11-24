import {
  MODEL_CAPABILITIES,
  MODEL_CREDENTIAL_PROVIDERS,
  MODEL_PROVIDERS,
} from "@deployments-ai/api-contract/models";
import type { CommandArgument, CommandCatalog } from "./types.ts";
import {
  action,
  create,
  description,
  flag,
  id,
  json,
  list,
  mutate,
  name,
  positional,
  repeatable,
  requiredNumber,
  show,
  text,
} from "./catalog-helpers.ts";

const MODEL_POLICIES_PATH = "/v1/model-policies";
const pagination = { limitField: "limit", maxLimit: 100, target: "query" } as const;
const MODEL_CREDENTIALS_PATH = "/v1/organizations/:id/model-credentials";
const organizationId = { ...positional("Organization ID"), field: "id" } as const;
const provider = {
  ...positional(`Model provider: ${MODEL_CREDENTIAL_PROVIDERS.join(" or ")}`),
  field: "provider",
} as const;

const expectedVersion = {
  ...requiredNumber("Expected model policy version"),
  field: "expectedVersion",
};
const policyModel = {
  ...repeatable("Allowed canonical model id or provider-wide entry such as openrouter/*"),
  bodyField: "models",
};
const policyModels = json("Allowed model entries as a JSON array");
const includeCuratedModels = (required: boolean): CommandArgument => ({
  definition: {
    type: "boolean",
    description:
      "Keep the platform's curated models allowed; pass --no-include-curated-models to allow only the listed models",
    ...(required ? { required: true } : {}),
  },
  target: "body",
});

export const modelCommandCatalog: CommandCatalog = {
  model: {
    summary: "Hosted model catalog and environment admission",
    actions: {
      list: {
        ...list(
          "/v1/models",
          "environment",
          "List catalog models and whether this environment allows them",
          pagination,
        ),
        args: {
          provider: {
            definition: {
              type: "enum",
              description: "Only models from this provider",
              options: [...MODEL_PROVIDERS],
            },
            target: "query",
          },
          capability: {
            definition: {
              type: "enum",
              description: "Only models that advertise this capability",
              options: [...MODEL_CAPABILITIES],
            },
            target: "query",
          },
          allowed: flag(
            "Only models this environment allows; --no-allowed lists denied models",
            "query",
          ),
          curated: flag("Only curated models; --no-curated lists non-curated models", "query"),
          search: text("Case-insensitive substring of the model id or display name", "query"),
        },
        columns: ["modelId", "provider", "contextWindowTokens", "curated", "allowed"],
      },
    },
  },
  "model-policy": {
    summary: "Environment model admission policy",
    actions: {
      create: create(
        MODEL_POLICIES_PATH,
        "environment",
        {
          name,
          description,
          "include-curated-models": includeCuratedModels(true),
          model: policyModel,
          models: policyModels,
        },
        "Create the environment model policy",
      ),
      list: list(MODEL_POLICIES_PATH, "environment", "List model policies", pagination),
      show: show(MODEL_POLICIES_PATH, "environment", "Show a model policy"),
      update: mutate("PATCH", MODEL_POLICIES_PATH, "environment", "Update a model policy", {
        id,
        name: text("Resource name"),
        description,
        "include-curated-models": includeCuratedModels(false),
        model: policyModel,
        models: policyModels,
        "expected-version": expectedVersion,
      }),
      archive: mutate("DELETE", MODEL_POLICIES_PATH, "environment", "Archive a model policy", {
        id,
        "expected-version": expectedVersion,
      }),
    },
  },
  "model-credential": {
    summary: "The organization's own model provider keys",
    actions: {
      list: action({
        summary: "List the organization's model provider keys; keys are shown by last four only",
        method: "GET",
        path: MODEL_CREDENTIALS_PATH,
        scope: "organization",
        output: "list",
        args: { "organization-id": organizationId },
        columns: ["provider", "status", "lastFour", "keyVersion", "label"],
      }),
      show: action({
        summary: "Show one model provider key without revealing it",
        method: "GET",
        path: `${MODEL_CREDENTIALS_PATH}/:provider`,
        scope: "organization",
        output: "detail",
        args: { "organization-id": organizationId, provider },
      }),
      set: action({
        summary: "Verify a provider key with the provider, then store or replace it",
        method: "PUT",
        path: `${MODEL_CREDENTIALS_PATH}/:provider`,
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          "organization-id": organizationId,
          provider,
          label: text("Label shown with the key"),
          "api-key": text("Provider API key (prefer env or file source)", "control"),
          "api-key-env": text("Environment variable containing the provider API key", "control"),
          "api-key-file": text("File containing the provider API key", "control"),
        },
        secretInputs: [
          {
            directArgument: "api-key",
            environmentArgument: "api-key-env",
            fileArgument: "api-key-file",
            bodyField: "apiKey",
            required: true,
          },
        ],
      }),
      remove: action({
        summary: "Remove a model provider key; its metadata stays for audit",
        method: "DELETE",
        path: `${MODEL_CREDENTIALS_PATH}/:provider`,
        scope: "organization",
        output: "detail",
        idempotent: true,
        destructive: true,
        args: { "organization-id": organizationId, provider },
      }),
    },
  },
};
