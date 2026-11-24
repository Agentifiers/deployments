import { Schema } from "effect";
import { Cursor, PublicId, ResourceName, Timestamp } from "./primitives.ts";

const Count = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Counts must be integers." }),
    Schema.isGreaterThanOrEqualTo(0, { message: "Counts must not be negative." }),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);

export const AppAccessLevel = Schema.Literals(["none", "viewer", "editor"]);
export const AppGrantRole = Schema.Literals(["viewer", "editor"]);
export const AppAudience = Schema.Literals(["members", "public"]);
export const AppServing = Schema.Literals(["single-page", "static-site"]);
export const AppPublication = Schema.Struct({ audience: AppAudience, serving: AppServing });

export const AppLifecycleResponse = Schema.Union([
  Schema.Struct({ requestedAt: Timestamp, state: Schema.Literal("provisioning") }),
  Schema.Struct({ failedAt: Timestamp, reason: Schema.String, state: Schema.Literal("failed") }),
  Schema.Struct({ liveReleaseId: Schema.NullOr(PublicId), state: Schema.Literal("active") }),
  Schema.Struct({
    archivedAt: Timestamp,
    liveReleaseId: Schema.NullOr(PublicId),
    state: Schema.Literal("archived"),
  }),
  Schema.Struct({ requestedAt: Timestamp, state: Schema.Literal("erasing") }),
]);

export const AppResponse = Schema.Struct({
  access: Schema.Struct({ organizationMembers: AppAccessLevel }),
  agentDefinitionId: PublicId,
  createdAt: Timestamp,
  createdBy: Schema.Struct({ principalId: Schema.NullOr(PublicId), runId: PublicId }),
  environmentId: PublicId,
  id: PublicId,
  lifecycle: AppLifecycleResponse,
  name: Schema.String,
  organizationId: PublicId,
  projectId: PublicId,
  publication: AppPublication,
  slug: Schema.String,
  updatedAt: Timestamp,
  url: Schema.String,
  workspaceId: PublicId,
});

export const ListAppsResponse = Schema.Struct({
  items: Schema.Array(AppResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export const UpdateAppRequest = Schema.Struct({
  access: Schema.optional(Schema.Struct({ organizationMembers: AppAccessLevel })),
  agentDefinitionId: Schema.optional(PublicId),
  name: Schema.optional(ResourceName),
}).pipe(
  Schema.check(
    Schema.makeFilter<{
      readonly access?: unknown;
      readonly agentDefinitionId?: unknown;
      readonly name?: unknown;
    }>((input) =>
      input.access !== undefined ||
      input.agentDefinitionId !== undefined ||
      input.name !== undefined
        ? undefined
        : "Provide name, access, or agentDefinitionId.",
    ),
  ),
);

export const SetAppPublicationRequest = Schema.Struct({
  audience: Schema.optional(AppAudience),
  serving: Schema.optional(AppServing),
}).pipe(
  Schema.check(
    Schema.makeFilter<{ readonly audience?: unknown; readonly serving?: unknown }>((input) =>
      input.audience !== undefined || input.serving !== undefined
        ? undefined
        : "Provide audience, serving, or both.",
    ),
  ),
);

export const PutAppGrantRequest = Schema.Struct({ role: AppGrantRole });

export const AppGrantResponse = Schema.Struct({
  appId: PublicId,
  createdAt: Timestamp,
  grantedBy: PublicId,
  principalId: PublicId,
  role: AppGrantRole,
  updatedAt: Timestamp,
});

export const ListAppGrantsResponse = Schema.Struct({
  items: Schema.Array(AppGrantResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export const AppReleaseResponse = Schema.Struct({
  appId: PublicId,
  bundleSha256: Schema.String,
  bytes: Count,
  createdAt: Timestamp,
  files: Count,
  id: PublicId,
  live: Schema.Boolean,
  runId: PublicId,
});

export const ListAppReleasesResponse = Schema.Struct({
  items: Schema.Array(AppReleaseResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export const AttachAppDomainRequest = Schema.Struct({
  hostname: Schema.String,
});

export const AppDomainDnsRecord = Schema.Struct({
  name: Schema.String,
  note: Schema.optional(Schema.String),
  type: Schema.Literals(["CNAME", "TXT"]),
  value: Schema.String,
});

const AppDomainProblem = Schema.NullOr(
  Schema.Struct({
    code: Schema.Literals([
      "certificate_failed",
      "certificate_timed_out",
      "domain_conflict",
      "edge_rejected",
      "organization_certificate_limit",
      "platform_certificate_limit",
      "previous_tenant_draining",
    ]),
    message: Schema.String,
    observedAt: Timestamp,
  }),
);

export const AppDomainState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unverified") }),
  Schema.Struct({
    kind: Schema.Literal("verified"),
    problem: AppDomainProblem,
    verifiedAt: Timestamp,
  }),
  Schema.Struct({
    activatedAt: Timestamp,
    kind: Schema.Literal("active"),
    problem: AppDomainProblem,
    verifiedAt: Timestamp,
  }),
]);

export const AppDomainResponse = Schema.Struct({
  appId: PublicId,
  attachedBy: Schema.Struct({
    id: PublicId,
    principal: Schema.Literals(["human", "service-account"]),
  }),
  createdAt: Timestamp,
  dnsRecords: Schema.Array(AppDomainDnsRecord),
  hostname: Schema.String,
  id: PublicId,
  state: AppDomainState,
  updatedAt: Timestamp,
});

export const ListAppDomainsResponse = Schema.Struct({
  items: Schema.Array(AppDomainResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export type AppAccessLevel = typeof AppAccessLevel.Type;
export type AppGrantRole = typeof AppGrantRole.Type;
export type AppAudience = typeof AppAudience.Type;
export type AppServing = typeof AppServing.Type;
export type AppPublication = typeof AppPublication.Type;
export type AppResponse = typeof AppResponse.Type;
export type UpdateAppRequest = typeof UpdateAppRequest.Type;
export type SetAppPublicationRequest = typeof SetAppPublicationRequest.Type;
export type PutAppGrantRequest = typeof PutAppGrantRequest.Type;
export type AppGrantResponse = typeof AppGrantResponse.Type;
export type AppReleaseResponse = typeof AppReleaseResponse.Type;
export type AttachAppDomainRequest = typeof AttachAppDomainRequest.Type;
export type AppDomainResponse = typeof AppDomainResponse.Type;

export const APPS_API_SCHEMAS = {
  AppDomainResponse,
  AppGrantResponse,
  AppReleaseResponse,
  AppResponse,
  AttachAppDomainRequest,
  ListAppDomainsResponse,
  ListAppGrantsResponse,
  ListAppReleasesResponse,
  ListAppsResponse,
  PutAppGrantRequest,
  SetAppPublicationRequest,
  UpdateAppRequest,
} as const;
