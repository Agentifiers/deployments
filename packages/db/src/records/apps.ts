import { Effect, Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";
import { AppDomainRecord, AppHostname } from "./app-domains.ts";

const APP_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,33}[a-z0-9]$/u;
const RESERVED_APP_SLUGS: Readonly<Record<string, true>> = {
  admin: true,
  api: true,
  app: true,
  apps: true,
  assets: true,
  auth: true,
  console: true,
  login: true,
  mail: true,
  static: true,
  status: true,
  www: true,
};

export const AppSlug = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) => {
      if (!APP_SLUG_PATTERN.test(input)) {
        return "App slugs have 3 to 35 lowercase letters, digits, or hyphens, start with a letter, and end with a letter or digit.";
      }
      if (input.includes("--")) return "App slugs must not contain consecutive hyphens.";
      if (input.startsWith("xn-")) return "App slugs must not start with xn-.";
      return Object.hasOwn(RESERVED_APP_SLUGS, input)
        ? `The app slug ${input} is reserved.`
        : undefined;
    }),
  ),
  Schema.brand("AppSlug"),
);
export type AppSlug = typeof AppSlug.Type;

const Sha256Hex = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9a-f]{64}$/u, { message: "Expected a lowercase SHA-256 hex digest." }),
  ),
);

export const AppSessionId = Sha256Hex.pipe(Schema.brand("AppSessionId"));
export type AppSessionId = typeof AppSessionId.Type;

export const AppLifecycleState = Schema.Literals([
  "provisioning",
  "failed",
  "active",
  "archived",
  "erasing",
]);
export type AppLifecycleState = typeof AppLifecycleState.Type;

export const AppLifecycle = Schema.Union([
  Schema.Struct({ requestedAt: Timestamp, state: Schema.Literal("provisioning") }),
  Schema.Struct({ failedAt: Timestamp, reason: NonEmptyString, state: Schema.Literal("failed") }),
  Schema.Struct({ liveReleaseId: Schema.NullOr(Ulid), state: Schema.Literal("active") }),
  Schema.Struct({
    archivedAt: Timestamp,
    liveReleaseId: Schema.NullOr(Ulid),
    state: Schema.Literal("archived"),
  }),
  Schema.Struct({ requestedAt: Timestamp, state: Schema.Literal("erasing") }),
]);
export type AppLifecycle = typeof AppLifecycle.Type;

export const AppAccessLevel = Schema.Literals(["none", "viewer", "editor"]);
export type AppAccessLevel = typeof AppAccessLevel.Type;

export const AppGrantRole = Schema.Literals(["viewer", "editor"]);
export type AppGrantRole = typeof AppGrantRole.Type;

export const AppAudience = Schema.Literals(["members", "public"]);
export type AppAudience = typeof AppAudience.Type;

export const AppServing = Schema.Literals(["single-page", "static-site"]);
export type AppServing = typeof AppServing.Type;

export const AppPublication = Schema.Struct({ audience: AppAudience, serving: AppServing });
export type AppPublication = typeof AppPublication.Type;

export const DEFAULT_APP_PUBLICATION: AppPublication = {
  audience: "members",
  serving: "single-page",
};

export const AppDatabaseLayout = NonNegativeSafeInteger.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1, { message: "App database layouts start at 1." })),
);

export const AppRecord = makeRecordSchema("app", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  access: Schema.Struct({ organizationMembers: AppAccessLevel }),
  agentDefinitionId: Ulid,
  clusterKey: NonEmptyString,
  createdBy: Schema.Struct({ principalId: Schema.NullOr(Ulid), runId: Ulid }),
  databaseConvergenceStartedAt: Schema.optional(Timestamp),
  databaseLayout: AppDatabaseLayout.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
  id: Ulid,
  lifecycle: AppLifecycle,
  name: NonEmptyString,
  publication: AppPublication.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_APP_PUBLICATION)),
  ),
  slug: AppSlug,
  status: AppLifecycleState,
  workspaceId: Ulid,
}).pipe(
  Schema.check(
    Schema.makeFilter((record) =>
      record.data.status === record.data.lifecycle.state
        ? undefined
        : { path: ["data", "status"], issue: "App status must project its lifecycle state." },
    ),
  ),
);
export type AppRecord = typeof AppRecord.Type;

export const APP_RELEASE_MAX_DOCUMENTS = 500;
export const APP_RELEASE_MAX_DOCUMENT_PATH_BYTES = 64 * 1024;
export const APP_RELEASE_MAX_PATH_CHARACTERS = 512;
const RELEASE_DOCUMENT_FILE = /\.html?$/iu;
/** The sandbox reports a file name that is not UTF-8 with U+FFFD in place of its bad bytes. */
const UNSAFE_PATH_CHARACTER = /[\\\p{Cc}\uFFFD]/u;
const pathEncoder = new TextEncoder();

export function isReleasePath(path: string): boolean {
  return (
    path.length <= APP_RELEASE_MAX_PATH_CHARACTERS &&
    !UNSAFE_PATH_CHARACTER.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function isReleaseDocumentFile(path: string): boolean {
  return RELEASE_DOCUMENT_FILE.test(path);
}

export const ReleaseDocumentPath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((path) =>
      isReleasePath(path) && isReleaseDocumentFile(path)
        ? undefined
        : "Expected a release-relative path of an .html or .htm file.",
    ),
  ),
  Schema.brand("ReleaseDocumentPath"),
);
export type ReleaseDocumentPath = typeof ReleaseDocumentPath.Type;

export function releaseDocumentsProblem(paths: readonly string[]): string | undefined {
  if (paths.length > APP_RELEASE_MAX_DOCUMENTS) {
    return `A release lists at most ${APP_RELEASE_MAX_DOCUMENTS} HTML documents; this one has ${paths.length}.`;
  }
  let bytes = 0;
  for (const path of paths) bytes += pathEncoder.encode(path).length;
  if (bytes > APP_RELEASE_MAX_DOCUMENT_PATH_BYTES) {
    return `The paths of a release's HTML documents total at most ${APP_RELEASE_MAX_DOCUMENT_PATH_BYTES / 1024} KiB; this one's total ${bytes} bytes.`;
  }
  return undefined;
}

export const ReleaseDocuments = Schema.Array(ReleaseDocumentPath).pipe(
  Schema.check(
    Schema.makeFilter((paths) => {
      for (let index = 1; index < paths.length; index += 1) {
        if (paths[index - 1]! >= paths[index]!)
          return "Release documents must be sorted and unique.";
      }
      return releaseDocumentsProblem(paths);
    }),
  ),
  Schema.brand("ReleaseDocuments"),
);
export type ReleaseDocuments = typeof ReleaseDocuments.Type;

export const AppReleaseRecord = makeRecordSchema("app-release", {
  ...tenantScopeFields,
  appId: Ulid,
  bundleSha256: Sha256Hex,
  bytes: NonNegativeSafeInteger,
  createdAt: Timestamp,
  documents: Schema.NullOr(ReleaseDocuments).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  files: NonNegativeSafeInteger,
  id: Ulid,
  runId: Ulid,
});
export type AppReleaseRecord = typeof AppReleaseRecord.Type;

export const AppGrantRecord = makeRecordSchema("app-grant", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  appId: Ulid,
  grantedBy: Ulid,
  id: Ulid,
  principalId: Ulid,
  role: AppGrantRole,
});
export type AppGrantRecord = typeof AppGrantRecord.Type;

// An erased app's origin keeps its browser storage and service workers, so its slug must never be
// reissued.
export const AppSlugReservationRecord = makeRecordSchema("app-slug-reservation", {
  appId: Ulid,
  reservedAt: Timestamp,
  slug: AppSlug,
});
export type AppSlugReservationRecord = typeof AppSlugReservationRecord.Type;

const AppMemberSessionSubject = Schema.Struct({
  email: Schema.NullOr(NonEmptyString),
  kind: Schema.Literal("member"),
  principalId: Ulid,
  sessionEpoch: NonNegativeSafeInteger,
  tokenSessionId: Ulid,
});

export const AppSessionSubject = Schema.Union([
  AppMemberSessionSubject,
  Schema.Struct({
    kind: Schema.Literal("agent-dev"),
    role: Schema.Literals(["viewer", "editor"]),
    runId: Ulid,
  }),
]);
export type AppSessionSubject = typeof AppSessionSubject.Type;
export type AppMemberSessionSubject = typeof AppMemberSessionSubject.Type;

export const AppHost = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("slug") }),
  Schema.Struct({ hostname: AppHostname, kind: Schema.Literal("custom") }),
]);
export type AppHost = typeof AppHost.Type;

const SLUG_HOST: AppHost = { kind: "slug" };

const AppHostDefaultingToSlug = AppHost.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(SLUG_HOST)),
);

export function sameAppHost(left: AppHost, right: AppHost) {
  return left.kind === "custom"
    ? right.kind === "custom" && left.hostname === right.hostname
    : right.kind === "slug";
}

export const AppSessionRecord = makeRecordSchema(
  "app-session",
  {
    appId: Ulid,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    host: AppHostDefaultingToSlug,
    id: AppSessionId,
    subject: AppSessionSubject,
  },
  { expiresAtField: "expiresAt" },
);
export type AppSessionRecord = typeof AppSessionRecord.Type;

/** A leading `//` or a backslash would name another origin. */
export const AppReturnPath = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\/(?![/\\])[^\\\p{Cc}]{0,2047}$/u, {
      message: "Expected a same-host path of at most 2048 characters.",
    }),
  ),
  Schema.brand("AppReturnPath"),
);
export type AppReturnPath = typeof AppReturnPath.Type;

export const AppLoginTransactionRecord = makeRecordSchema(
  "app-login-transaction",
  {
    appId: Ulid,
    bindingHash: Sha256Hex,
    codeVerifier: NonEmptyString,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    host: AppHostDefaultingToSlug,
    id: Sha256Hex,
    nonceHash: Sha256Hex,
    returnTo: AppReturnPath,
  },
  { expiresAtField: "expiresAt" },
);
export type AppLoginTransactionRecord = typeof AppLoginTransactionRecord.Type;

export const AppLoginHandoffRecord = makeRecordSchema(
  "app-login-handoff",
  {
    appId: Ulid,
    bindingHash: Sha256Hex,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    host: AppHostDefaultingToSlug,
    id: Sha256Hex,
    returnTo: AppReturnPath,
    subject: AppMemberSessionSubject,
  },
  { expiresAtField: "expiresAt" },
);
export type AppLoginHandoffRecord = typeof AppLoginHandoffRecord.Type;

export const APP_CONTROL_RECORD_SCHEMAS = {
  app: AppRecord,
  "app-domain": AppDomainRecord,
  "app-grant": AppGrantRecord,
  "app-release": AppReleaseRecord,
  "app-slug-reservation": AppSlugReservationRecord,
} as const;
