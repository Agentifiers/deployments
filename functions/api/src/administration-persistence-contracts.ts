import { type CredentialVaultReference } from "@deployments-ai/credential-vault";
import {
  PersistenceError,
  Ulid,
  acquireUniqueClaim,
  makeUniqueClaimRecord,
  releaseUniqueClaim,
  uniqueClaimRequirements,
  type DynamoDatabaseService,
  type LoadModelOperatorGrants,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import {
  type PlatformOAuthAppConfig,
  type ProviderDefinition,
  type ProviderDefinitionRegistry,
} from "@deployments-ai/providers";
import { Schema } from "effect";
import type { AdministrationInvocation } from "./administration-api.ts";
import { type AdministrationProviderVerificationPort } from "./provider-verification.ts";
import type { HostedCodeArtifactObjectStore } from "./hosted-code-artifact-administration.ts";
import type { VendorMcpAdministrationDependencies } from "./vendor-mcp-dependencies.ts";

export type { AdministrationInvocation } from "./administration-api.ts";

export interface AdministrationEnvironment {
  readonly id: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly status: string;
}

export type SecretReferenceValue = CredentialVaultReference;

export interface AdministrationCredentialIdentity {
  readonly credentialId: Ulid;
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly ownerId: Ulid;
  readonly ownerType:
    | "mcp-server"
    | "oauth-authorization-attempt"
    | "provider-application"
    | "provider-connection"
    | "tool-adapter";
  readonly projectId: Ulid;
  readonly purpose: string;
}

export interface AdministrationPreparedCredentialMutation {
  readonly operation: TransactionOperation;
  readonly reference: SecretReferenceValue;
}

export interface AdministrationCredentialPort {
  readonly prepareRevoke: (input: {
    readonly environmentId: Ulid;
    readonly organizationId: Ulid;
    readonly reference: SecretReferenceValue;
  }) => Promise<AdministrationPreparedCredentialMutation>;
  readonly prepareWrite: (input: {
    readonly expectedGeneration?: number;
    readonly identity: AdministrationCredentialIdentity;
    readonly secret: {
      readonly expiresAt?: string;
      readonly scopes?: readonly string[];
      readonly values: Readonly<Record<string, string>>;
    };
  }) => Promise<AdministrationPreparedCredentialMutation>;
  readonly read: (input: {
    readonly environmentId: Ulid;
    readonly expectedIdentity: Pick<
      AdministrationCredentialIdentity,
      "ownerId" | "ownerType" | "projectId" | "purpose"
    >;
    readonly organizationId: Ulid;
    readonly reference: SecretReferenceValue;
  }) => Promise<{
    readonly scopes?: readonly string[];
    readonly values: Readonly<Record<string, string>>;
  }>;
}

export interface AdministrationMcpDiscoveryPort {
  readonly discover: (input: {
    readonly endpointOrigin: string;
    readonly endpointPath: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly toolAllowlist: readonly string[];
  }) => Promise<
    readonly {
      readonly description?: string;
      readonly inputSchema: Readonly<Record<string, unknown>>;
      readonly remoteName: string;
    }[]
  >;
}

export interface AdministrationPersistenceDependencies {
  readonly credentials: AdministrationCredentialPort;
  readonly database: DynamoDatabaseService;
  /** Immutable hosted code artifact object storage (artifact bucket, SSE-KMS). */
  readonly hostedCodeArtifacts?: HostedCodeArtifactObjectStore;
  readonly mcpDiscovery: AdministrationMcpDiscoveryPort;
  readonly providerVerification: AdministrationProviderVerificationPort;
  readonly oauthApplications?: Readonly<Record<string, PlatformOAuthAppConfig>>;
  /** `PLATFORM_OAUTH_RETURN_ORIGINS`; empty or absent rejects every authorization `returnTo`. */
  readonly oauthReturnOrigins?: readonly string[];
  readonly providers?: ProviderDefinitionRegistry;
  readonly generateId?: () => Promise<string>;
  /** Operator model grants, so the model listing's `allowed` flags match publish admission. */
  readonly loadModelOperatorGrants?: LoadModelOperatorGrants;
  readonly now?: () => Date;
  readonly resolveEnvironment: (
    invocation: AdministrationInvocation,
  ) => Promise<AdministrationEnvironment | undefined>;
  readonly resolveWorkspace: (
    environment: AdministrationEnvironment,
    workspaceId: Ulid,
  ) => Promise<boolean>;
  /** Vendor-hosted MCP network ports; vendor_mcp operations fail closed when absent. */
  readonly vendorMcp?: VendorMcpAdministrationDependencies;
}

export type EnvironmentRecord = Extract<
  PlatformRecord,
  {
    readonly itemType:
      | "connection-capability"
      | "connection-verification"
      | "mcp-connection"
      | "mcp-server"
      | "provider-application"
      | "provider-connection"
      | "tool-adapter"
      | "tool-policy"
      | "workspace-connection-authorization";
  }
>;
export type EnvironmentItemType = EnvironmentRecord["itemType"];

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_request",
      "Request body must be an object.",
    );
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PersistenceError("invalid-input", "invalid_request", `${field} is required.`);
  }
  return value.trim();
}

export function strings(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_request",
      `${field} must be a string array.`,
    );
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].toSorted();
}

export function metadata(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersistenceError("invalid-input", "invalid_request", "metadata must be an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

const JSON_SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "properties",
]);
const JSON_SCHEMA_SINGLE_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const JSON_SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

export function extensionInputSchema(value: unknown): Readonly<Record<string, unknown>> {
  const schema = metadata(value);
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    const object = candidate as Readonly<Record<string, unknown>>;
    if (Object.hasOwn(object, "pattern") || Object.hasOwn(object, "patternProperties")) {
      throw new PersistenceError(
        "unprocessable",
        "unsafe_input_schema",
        "Extension input schemas cannot contain regular-expression keywords.",
      );
    }
    for (const [keyword, child] of Object.entries(object)) {
      if (
        JSON_SCHEMA_MAP_KEYWORDS.has(keyword) &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        for (const nestedSchema of Object.values(child)) visit(nestedSchema);
      } else if (JSON_SCHEMA_SINGLE_KEYWORDS.has(keyword) && child && typeof child === "object") {
        visit(child);
      } else if (JSON_SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(child)) {
        for (const nestedSchema of child) visit(nestedSchema);
      }
    }
  };
  visit(schema);
  return schema;
}

export function expectedVersion(body: Record<string, unknown>, actual: number) {
  if (
    body.expectedVersion !== undefined &&
    (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== actual)
  ) {
    throw new PersistenceError("conflict", "version_conflict", "The resource version has changed.");
  }
}

export function id(value: string): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new PersistenceError("invalid-input", "invalid_id", "A canonical ULID is required.");
  }
}

export function resourceId(invocation: AdministrationInvocation, parameter = "id"): Ulid {
  const value = invocation.id ?? invocation.params[parameter];
  if (!value) {
    throw new PersistenceError(
      "invalid-input",
      "resource_id_required",
      "A resource identifier is required.",
    );
  }
  return id(value);
}

export function secretValues(
  value: unknown,
  defaultField: string,
): Readonly<Record<string, string>> {
  if (typeof value === "string" && value.length > 0) return { [defaultField]: value };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0 ||
    Object.values(value).some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_secret",
      "A non-empty secret is required.",
    );
  }
  return value as Readonly<Record<string, string>>;
}

export function providerCredentialValues(
  value: unknown,
  definition: ProviderDefinition,
): Readonly<Record<string, string>> {
  const declared = new Map(definition.auth.fields.map((field) => [field.key, field]));
  let provided: Readonly<Record<string, string>>;
  if (typeof value === "string" && value.length > 0) {
    const candidates = definition.auth.fields.filter((field) => field.sensitive);
    if (candidates.length !== 1) {
      throw new PersistenceError(
        "invalid-input",
        "invalid_secret",
        "A scalar credential is ambiguous for this provider; provide a credential object.",
      );
    }
    provided = { [candidates[0]!.key]: value };
  } else {
    provided = secretValues(value, "credential");
  }
  const unknown = Object.keys(provided).filter((field) => !declared.has(field));
  if (unknown.length > 0) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_secret",
      `Credential contains undeclared provider fields: ${unknown.join(", ")}.`,
    );
  }
  const values = Object.fromEntries([
    ...definition.auth.fields.flatMap((field) =>
      field.defaultValue === undefined ? [] : ([[field.key, field.defaultValue]] as const),
    ),
    ...Object.entries(provided),
  ]);
  const missing = definition.auth.fields.filter(
    (field) => field.required && !values[field.key]?.trim(),
  );
  if (missing.length > 0) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_secret",
      `Credential is missing required provider fields: ${missing.map((field) => field.key).join(", ")}.`,
    );
  }
  return values;
}

export function credentialGeneration(reference: SecretReferenceValue): number | undefined {
  return reference.generation;
}

export function vaultReference(value: unknown): SecretReferenceValue {
  if (
    !value ||
    typeof value !== "object" ||
    !("store" in value) ||
    value.store !== "dynamodb-kms" ||
    !("credentialId" in value) ||
    typeof value.credentialId !== "string" ||
    !("generation" in value) ||
    !Number.isSafeInteger(value.generation)
  ) {
    throw new PersistenceError(
      "unprocessable",
      "invalid_credential_reference",
      "Resource does not use the credential vault.",
    );
  }
  return value as SecretReferenceValue;
}

function claimKey(requirement: ReturnType<typeof uniqueClaimRequirements>[number]) {
  return `${requirement.namespace}\u0000${requirement.value}`;
}

export function recordOperations(
  next: PlatformRecord,
  timestamp: string,
  previous?: PlatformRecord,
): TransactionOperation[] {
  const operations: TransactionOperation[] = [
    previous
      ? { kind: "put", previousRecord: previous, record: next }
      : { kind: "put", record: next },
  ];
  const before = previous ? uniqueClaimRequirements(previous) : [];
  const after = uniqueClaimRequirements(next);
  const beforeKeys = new Set(before.map(claimKey));
  const afterKeys = new Set(after.map(claimKey));
  operations.push(
    ...after
      .filter((requirement) => !beforeKeys.has(claimKey(requirement)))
      .map((requirement) =>
        acquireUniqueClaim(
          makeUniqueClaimRecord(requirement, timestamp) as Extract<
            PlatformRecord,
            { readonly itemType: "unique-claim" }
          >,
        ),
      ),
    ...before
      .filter((requirement) => !afterKeys.has(claimKey(requirement)))
      .map((requirement) =>
        releaseUniqueClaim(
          makeUniqueClaimRecord(requirement, timestamp) as Extract<
            PlatformRecord,
            { readonly itemType: "unique-claim" }
          >,
        ),
      ),
  );
  return operations;
}

export function activeRecordCondition(record: EnvironmentRecord): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#version = :version AND #data.#status = :status",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":itemType": record.itemType,
      ":status": "active",
      ":version": record.data.version,
    },
    key: { pk: record.pk, sk: record.sk },
    kind: "condition-check",
    table: "control",
  };
}
