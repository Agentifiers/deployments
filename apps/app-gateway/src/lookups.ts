import {
  makeIdentityRepository,
  organizationAccess,
  type AppDomainRecord,
  type AppGrantRole,
  type AppHostname,
  type AppPersistence,
  type AppRecord,
  type DynamoDatabaseService,
  type HoldState,
  type OrganizationAccess,
  type OrganizationHoldReader,
  type ReleaseDocuments,
  type Ulid,
} from "@deployments-ai/db";

export interface MemberAccessInput {
  readonly organizationId: Ulid;
  readonly principalId: Ulid;
  readonly tokenSessionId: Ulid;
}

export type MemberAccess = (input: MemberAccessInput) => Promise<OrganizationAccess>;

export type SessionEpoch = (principalId: Ulid) => Promise<number | undefined>;

export interface GatewayLookups {
  readonly app: (appId: Ulid) => Promise<AppRecord | undefined>;
  readonly domain: (hostname: AppHostname) => Promise<AppDomainRecord | undefined>;
  readonly grantRole: (input: {
    readonly app: AppRecord;
    readonly principalId: Ulid;
  }) => Promise<AppGrantRole | undefined>;
  readonly memberAccess: MemberAccess;
  readonly releaseDocuments: (input: {
    readonly app: AppRecord;
    readonly releaseId: Ulid;
  }) => Promise<ReleaseDocuments | null>;
  readonly sessionEpoch: SessionEpoch;
  readonly standing: (organizationId: Ulid) => Promise<HoldState>;
}

const MAXIMUM_ENTRIES = 10_000;
const LOOKUP_TTL_MS = 5_000;

function ttlCache<Value>(now: () => Date) {
  const entries = new Map<string, { readonly expiresAt: number; readonly value: Promise<Value> }>();
  return (key: string, load: () => Promise<Value>) => {
    const at = now().getTime();
    const cached = entries.get(key);
    if (cached && cached.expiresAt > at) return cached.value;
    entries.delete(key);
    if (entries.size >= MAXIMUM_ENTRIES) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    const value = load();
    entries.set(key, { expiresAt: at + LOOKUP_TTL_MS, value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}

export function cachedLookups(input: {
  readonly apps: Pick<AppPersistence, "domainForHostname" | "getApp" | "getGrant" | "getRelease">;
  readonly memberAccess: MemberAccess;
  readonly now: () => Date;
  readonly sessionEpoch: SessionEpoch;
  readonly standing: OrganizationHoldReader;
}): GatewayLookups {
  const apps = ttlCache<AppRecord | undefined>(input.now);
  const domains = ttlCache<AppDomainRecord | undefined>(input.now);
  const grants = ttlCache<AppGrantRole | undefined>(input.now);
  const access = ttlCache<OrganizationAccess>(input.now);
  const epochs = ttlCache<number | undefined>(input.now);
  const documents = ttlCache<ReleaseDocuments | null>(input.now);
  const holds = ttlCache<HoldState>(input.now);
  return {
    app: (appId) => apps(appId, () => input.apps.getApp(appId)),
    domain: (hostname) => domains(hostname, () => input.apps.domainForHostname(hostname)),
    grantRole: ({ app, principalId }) =>
      grants(`${app.data.id}/${principalId}`, async () => {
        const grant = await input.apps.getGrant({ app, principalId });
        return grant?.data.role;
      }),
    memberAccess: (request) =>
      access(`${request.organizationId}/${request.principalId}/${request.tokenSessionId}`, () =>
        input.memberAccess(request),
      ),
    releaseDocuments: ({ app, releaseId }) =>
      documents(`${app.data.id}/${releaseId}`, async () => {
        const release = await input.apps.getRelease({ app, releaseId });
        return release?.data.documents ?? null;
      }),
    sessionEpoch: (principalId) => epochs(principalId, () => input.sessionEpoch(principalId)),
    standing: (organizationId) => holds(organizationId, () => input.standing.read(organizationId)),
  };
}

export function liveSessionEpoch(database: DynamoDatabaseService): SessionEpoch {
  const identity = makeIdentityRepository(database);
  return async (principalId) =>
    (await identity.securityStateForPrincipal(principalId))?.data.sessionEpoch;
}

export function liveMemberAccess(database: DynamoDatabaseService): MemberAccess {
  const identity = makeIdentityRepository(database);
  return async (input) => {
    const principal = await identity.principalForId(input.principalId);
    if (principal?.data.kind !== "human" || principal.data.status !== "active") {
      return { kind: "denied" };
    }
    return organizationAccess(database, { ...input, platformAdministrator: false });
  };
}
