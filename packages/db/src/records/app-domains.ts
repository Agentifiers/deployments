import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  ActorReference,
  DNS_HOST_NAME_PATTERN,
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";

export const APP_DOMAIN_LIMIT = 10;

export const APP_DOMAIN_PROOF_LABEL = "deployments-app";

const DNS_NAME_MAX_LENGTH = 253;
const APP_HOSTNAME_MAX_LENGTH = DNS_NAME_MAX_LENGTH - `_${APP_DOMAIN_PROOF_LABEL}.`.length;

export const AppHostname = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(APP_HOSTNAME_MAX_LENGTH, {
      message: `Expected at most ${APP_HOSTNAME_MAX_LENGTH} characters, so the TXT proof name fits in DNS.`,
    }),
    Schema.isPattern(DNS_HOST_NAME_PATTERN, {
      message: "Expected a lowercase ASCII host name with at least two labels.",
    }),
  ),
  Schema.brand("AppHostname"),
);
export type AppHostname = typeof AppHostname.Type;

export const AppDomainToken = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/u, { message: "Expected 32 lowercase hex." })),
  Schema.brand("AppDomainToken"),
);
export type AppDomainToken = typeof AppDomainToken.Type;

export const AppDomainProblem = Schema.Struct({
  code: Schema.Literals([
    "certificate_failed",
    "certificate_timed_out",
    "domain_conflict",
    "edge_rejected",
    "organization_certificate_limit",
    "platform_certificate_limit",
    "previous_tenant_draining",
  ]),
  message: NonEmptyString,
  observedAt: Timestamp,
  /**
   * Consecutive tenant creates the edge rejected, each of which may have spent an ACM certificate
   * request, and when the latest was rejected. The create backoff counts from `latestAt`, so
   * recording the problem again does not move it.
   */
  rejectedCreates: Schema.optional(
    Schema.Struct({
      count: NonNegativeSafeInteger.pipe(
        Schema.check(Schema.isGreaterThanOrEqualTo(1, { message: "Expected at least one." })),
      ),
      latestAt: Timestamp,
    }),
  ),
});
export type AppDomainProblem = typeof AppDomainProblem.Type;

/**
 * A tenant create that did not create the tenant. CloudFront may have requested a certificate for
 * it that ACM did not list yet, so the reconciler keeps looking for one requested in this window.
 */
export const AppDomainCertificateSearch = Schema.Struct({
  endedAt: Timestamp,
  startedAt: Timestamp,
});
export type AppDomainCertificateSearch = typeof AppDomainCertificateSearch.Type;

const CertificateSearches = Schema.optional(Schema.Array(AppDomainCertificateSearch));

export const AppDomainState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unverified") }),
  Schema.Struct({
    certificateSearches: CertificateSearches,
    kind: Schema.Literal("verified"),
    problem: Schema.NullOr(AppDomainProblem),
    slot: NonNegativeSafeInteger,
    verifiedAt: Timestamp,
  }),
  Schema.Struct({
    activatedAt: Timestamp,
    certificateSearches: CertificateSearches,
    kind: Schema.Literal("active"),
    problem: Schema.NullOr(AppDomainProblem),
    slot: NonNegativeSafeInteger,
    verifiedAt: Timestamp,
  }),
]);
export type AppDomainState = typeof AppDomainState.Type;
export type PublishedAppDomainState = Exclude<AppDomainState, { readonly kind: "unverified" }>;

export const AppDomainRecord = makeRecordSchema("app-domain", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  appId: Ulid,
  appSlot: NonNegativeSafeInteger.pipe(
    Schema.check(
      Schema.isLessThanOrEqualTo(APP_DOMAIN_LIMIT - 1, {
        message: `App domain slots are below ${APP_DOMAIN_LIMIT}.`,
      }),
    ),
  ),
  attachedBy: ActorReference,
  hostname: AppHostname,
  id: Ulid,
  state: AppDomainState,
  token: AppDomainToken,
});
export type AppDomainRecord = typeof AppDomainRecord.Type;
export type PublishedAppDomain = AppDomainRecord & {
  readonly data: { readonly state: PublishedAppDomainState };
};

export function isPublishedAppDomain(domain: AppDomainRecord): domain is PublishedAppDomain {
  return domain.data.state.kind !== "unverified";
}
