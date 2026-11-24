import {
  AppDatabaseError,
  type ApiCallInput,
  type ApiCallResult,
} from "@deployments-ai/app-database";
import {
  AppSlug,
  bffFenceRecord,
  isReleaseDocumentFile,
  makeAppPersistence,
  makeIdentityRepository,
  makeIdGenerator,
  organizationMemberRecord,
  principalRecord,
  securityStateRecord,
  Ulid,
  type AppAccessLevel,
  type AppPersistence,
  type AppRecord,
  type AppServing,
  type AppPublication,
  type HoldReason,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { PlatformRecord, withCanonicalRecordKeys } from "@deployments-ai/db/records";
import { randomToken, systemRandom } from "@deployments-ai/identity";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { makeOidcClient } from "@deployments-ai/web-bff-auth";
import { makeFakeIdentityServer } from "@deployments-ai/web-bff-auth/testing";
import { Schema } from "effect";
import { sessionIdOf } from "./admission.ts";
import { apiCallLimits } from "./api-calls.ts";
import { DEFAULT_VISITOR_LIMITS } from "./config.ts";
import { domainFixture, type DomainFixture } from "./domain-test-support.ts";
import { createAppGateway, type RequestLogEntry } from "./gateway.ts";
import { cachedLookups, liveMemberAccess, liveSessionEpoch } from "./lookups.ts";
import { makePlatformSignIn } from "./platform-identity.ts";
import { APP_HOST_HEADER, APP_ID_HEADER } from "./routes.ts";
import { tokenBuckets, VIEWER_ADDRESS_HEADER } from "./visitor-calls.ts";

export const id = Schema.decodeUnknownSync(Ulid);
const slug = Schema.decodeUnknownSync(AppSlug);

export const START = "2026-10-08T12:00:00.000Z";
export const APPS_DOMAIN = "apps.test";
const ISSUER = "https://auth.test";
const CLIENT_ID = "deployments-apps";

export const ORGANIZATION = id("01ARZ3NDEKTSV4RRFFQ69G5FA0");
export const SSO_ORGANIZATION = id("01ARZ3NDEKTSV4RRFFQ69G5FA1");
const PROJECT = id("01ARZ3NDEKTSV4RRFFQ69G5FA2");
const ENVIRONMENT = id("01ARZ3NDEKTSV4RRFFQ69G5FA3");
const WORKSPACE = id("01ARZ3NDEKTSV4RRFFQ69G5FA4");
const AGENT = id("01ARZ3NDEKTSV4RRFFQ69G5FA5");
export const RUN = id("01ARZ3NDEKTSV4RRFFQ69G5FA6");
export const MEMBER = id("01ARZ3NDEKTSV4RRFFQ69G5FA7");
export const OWNER = id("01ARZ3NDEKTSV4RRFFQ69G5FA8");
export const TOKEN_SESSION = id("01ARZ3NDEKTSV4RRFFQ69G5FA9");
export const ADMINISTRATOR = id("01ARZ3NDEKTSV4RRFFQ69G5FB1");
export const DISABLED_MEMBER = id("01ARZ3NDEKTSV4RRFFQ69G5FB2");
export const SERVICE_MEMBER = id("01ARZ3NDEKTSV4RRFFQ69G5FB3");
const AUTOMATION = id("01ARZ3NDEKTSV4RRFFQ69G5FB4");
const SESSION_EPOCH = 3;

export const UNIQUE_VIOLATION =
  'duplicate key value violates unique constraint "members_email_key"\nDETAIL: Key (email)=(ada@example.com) already exists.';

export const INDEX_HTML =
  '<!doctype html><html><head><title>Payroll</title></head><body><script type="module" src="./assets/app.js"></script></body></html>';

function seedRecords() {
  const member = (organizationId: Ulid, principalId: Ulid, role: "member" | "owner") =>
    organizationMemberRecord({
      createdAt: START,
      organizationId,
      principalId,
      role,
      status: "active",
      updatedAt: START,
      version: 1,
    });
  const requiredSso = Schema.decodeUnknownSync(PlatformRecord)(
    withCanonicalRecordKeys({
      data: {
        clientId: "0oa-client",
        clientSecret: {
          algorithm: "AES-256-GCM",
          authenticationTag: "tag",
          ciphertext: "ciphertext",
          encryptedDataKey: "key",
          encryptionContextHash: "hash",
          iv: "iv",
          schemaVersion: 1,
        },
        clientSecretSetAt: START,
        connectionId: id("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
        createdAt: START,
        displayName: "Acme Okta",
        endpoints: {
          authorization: "https://acme.okta.test/authorize",
          jwks: "https://acme.okta.test/keys",
          token: "https://acme.okta.test/token",
        },
        id: "oidc",
        issuer: "https://acme.okta.test",
        jit: { kind: "enabled", role: "member" },
        organizationId: SSO_ORGANIZATION,
        signingAlgorithms: ["RS256"],
        state: { enforcement: "required", kind: "active" },
        tokenEndpointAuthMethod: "client_secret_basic",
        updatedAt: START,
        version: 1,
      },
      itemType: "organization-identity-provider",
    }),
  );
  const principals = [MEMBER, OWNER, ADMINISTRATOR, DISABLED_MEMBER, SERVICE_MEMBER];
  const securityStates = principals.flatMap((principalId) => [
    securityStateRecord({
      createdAt: START,
      credentialVersion: 1,
      principalId,
      sessionEpoch: SESSION_EPOCH,
      version: 1,
    }),
    bffFenceRecord({
      createdAt: START,
      principalId,
      principalStatus: "active",
      sessionEpoch: SESSION_EPOCH,
      version: 1,
    }),
  ]);
  const service = principalRecord({
    createdAt: START,
    id: SERVICE_MEMBER,
    primaryEmail: "service@example.com",
  });
  return [
    principalRecord({ createdAt: START, id: MEMBER, primaryEmail: "member@example.com" }),
    principalRecord({ createdAt: START, id: OWNER, primaryEmail: "owner@example.com" }),
    principalRecord({
      createdAt: START,
      id: ADMINISTRATOR,
      platformRole: "administrator",
      primaryEmail: "admin@example.com",
    }),
    principalRecord({
      createdAt: START,
      id: DISABLED_MEMBER,
      primaryEmail: "disabled@example.com",
      status: "disabled",
    }),
    { ...service, data: { ...service.data, kind: "service" as const } },
    ...securityStates,
    member(ORGANIZATION, MEMBER, "member"),
    member(ORGANIZATION, OWNER, "owner"),
    member(ORGANIZATION, DISABLED_MEMBER, "member"),
    member(ORGANIZATION, SERVICE_MEMBER, "member"),
    member(SSO_ORGANIZATION, MEMBER, "member"),
    requiredSso,
  ];
}

export interface Viewer {
  readonly address: string | null;
}

export interface CustomSite {
  readonly app: AppRecord;
  readonly hostname: string;
}

export type Site = AppRecord | CustomSite | "apex";

function hostOf(site: Site) {
  if (site === "apex") return APPS_DOMAIN;
  return "hostname" in site ? site.hostname : `${site.data.slug}.${APPS_DOMAIN}`;
}

export class Browser {
  readonly #jars = new Map<string, Map<string, string>>();

  constructor(
    private readonly origin: string,
    private readonly viewer: Viewer,
  ) {}

  cookie(site: Site, name: string) {
    return this.#jars.get(hostOf(site))?.get(name);
  }

  setCookie(site: Site, name: string, value: string) {
    const jar = this.#jars.get(hostOf(site)) ?? new Map<string, string>();
    jar.set(name, value);
    this.#jars.set(hostOf(site), jar);
  }

  async request(
    site: Site,
    path: string,
    init: {
      readonly body?: string;
      readonly headers?: Record<string, string>;
      readonly method?: string;
    } = {},
  ) {
    const host = hostOf(site);
    const jar = this.#jars.get(host) ?? new Map<string, string>();
    const headers = new Headers(init.headers);
    if (site !== "apex") {
      const custom = "hostname" in site;
      headers.set(APP_ID_HEADER, custom ? site.app.data.id : site.data.id);
      if (custom) headers.set(APP_HOST_HEADER, site.hostname);
      if (this.viewer.address !== null) headers.set(VIEWER_ADDRESS_HEADER, this.viewer.address);
    }
    if (jar.size > 0) {
      headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(`${this.origin}${path}`, {
      ...(init.body === undefined ? {} : { body: init.body }),
      headers,
      method: init.method ?? "GET",
      redirect: "manual",
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      if (/max-age=0(?:;|$)/iu.test(header)) jar.delete(name);
      else jar.set(name, pair.slice(separator + 1));
    }
    this.#jars.set(host, jar);
    return response;
  }
}

export interface SignInStep {
  readonly authorize: Response;
  readonly callback: Response;
  readonly completePath: string;
}

export interface FakeAppDatabase {
  readonly calls: ApiCallInput[];
  readonly callApiFunction: (input: ApiCallInput) => Promise<ApiCallResult>;
  readonly releaseHeld: () => void;
  readonly signUps: ApiCallInput["args"][];
  readonly whenHeld: (count: number) => Promise<void>;
  unavailable: boolean;
}

export const VISITOR_DEADLINE_MS = 250;
const VISITOR_FUNCTIONS: Readonly<Record<string, true>> = { hold: true, sign_up: true };

export interface GatewayHarness extends DomainFixture {
  readonly activeApp: (input: {
    readonly access: AppAccessLevel;
    readonly name: string;
    readonly organizationId?: Ulid;
  }) => Promise<AppRecord>;
  readonly advance: (milliseconds: number) => void;
  readonly apps: AppPersistence;
  readonly browser: (viewer?: Partial<Viewer>) => Browser;
  readonly callback: (
    browser: Browser,
    authorize: Response,
    principalId: Ulid,
  ) => Promise<Response>;
  readonly database: FakeAppDatabase;
  readonly devToken: (app: AppRecord, role: "editor" | "viewer") => Promise<string>;
  /** Places and releases holds on {@link ORGANIZATION}. */
  readonly holds: {
    readonly place: (reason: HoldReason) => Promise<unknown>;
    readonly release: (reason: HoldReason) => Promise<unknown>;
  };
  readonly logs: readonly RequestLogEntry[];
  /** The name of each platform persistence method the gateway called, in order. */
  readonly persistenceCalls: readonly string[];
  readonly reads: readonly string[];
  readonly release: (
    app: AppRecord,
    content: string | Readonly<Record<string, string | null>> | undefined,
    promote: boolean,
  ) => Promise<{ readonly app: AppRecord; readonly releaseId: Ulid }>;
  readonly publish: (app: AppRecord, audience: AppPublication["audience"]) => Promise<AppRecord>;
  readonly serve: (app: AppRecord, serving: AppServing) => Promise<AppRecord>;
  readonly signIn: (
    browser: Browser,
    site: AppRecord | CustomSite,
    principalId: Ulid,
  ) => Promise<Response>;
  readonly signOutEverywhere: (principalId: Ulid) => Promise<void>;
  readonly startSignIn: (
    browser: Browser,
    site: AppRecord | CustomSite,
    principalId: Ulid,
    returnTo?: string,
  ) => Promise<SignInStep>;
  readonly stop: () => Promise<void>;
}

function recordingCalls<Service extends object>(service: Service, calls: string[]): Service {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export async function gatewayHarness(): Promise<GatewayHarness> {
  let clock = Date.parse(START);
  const now = () => new Date(clock);
  const memory = evaluationMemoryDatabase(seedRecords());
  const standing = standingInstallation({ organizationId: ORGANIZATION });
  const ids = makeIdGenerator();
  const apps = makeAppPersistence({ database: memory.database, generateId: ids.generate, now });
  const domains = domainFixture({ apps, automation: AUTOMATION, now, person: OWNER });
  const persistenceCalls: string[] = [];
  const gatewayApps = recordingCalls(
    { ...apps, domainForHostname: domains.domainForHostname },
    persistenceCalls,
  );
  const clientSecret = randomToken();
  const identityServer = await makeFakeIdentityServer({
    clientId: CLIENT_ID,
    clientSecret,
    issuer: ISSUER,
    now,
  });
  const redirectUri = `https://${APPS_DOMAIN}/_platform/auth/callback`;
  const releases = new Map<string, string>();
  const reads: string[] = [];
  const calls: ApiCallInput[] = [];
  const held: (() => void)[] = [];
  let onHold = () => {};
  const database: FakeAppDatabase = {
    calls,
    async callApiFunction(input: ApiCallInput): Promise<ApiCallResult> {
      calls.push(input);
      if (database.unavailable) {
        throw new AppDatabaseError({
          cause: new Error("Connection terminated due to connection timeout"),
          code: "database_unavailable",
          message: "Connection terminated due to connection timeout",
        });
      }
      if (
        input.role === "visitor" &&
        !(input.appIsPublic && VISITOR_FUNCTIONS[input.functionName])
      ) {
        throw new AppDatabaseError({
          code: "visitor_not_allowed",
          message: `Visitors cannot call ${JSON.stringify(input.functionName)}.`,
        });
      }
      switch (input.functionName) {
        case "sign_up":
          database.signUps.push(input.args);
          return { rows: [{ id: database.signUps.length }] };
        case "add_member":
          throw new AppDatabaseError({ code: "postgres_error", message: UNIQUE_VIOLATION });
        case "create_order":
          if (input.role === "viewer") {
            throw new AppDatabaseError({
              code: "function_not_allowed",
              message: "api.create_order is volatile and needs editor access.",
            });
          }
          break;
        case "export_everything":
          throw new AppDatabaseError({
            code: "result_too_large",
            message: "api.export_everything returned more than 1048576 bytes.",
          });
        case "hold": {
          const { promise, reject, resolve } = Promise.withResolvers<void>();
          held.push(resolve);
          onHold();
          const { deadlineMs } = input;
          const timer =
            deadlineMs === undefined
              ? undefined
              : setTimeout(() => {
                  held.splice(held.indexOf(resolve), 1);
                  reject(
                    new AppDatabaseError({
                      code: "deadline_exceeded",
                      message: `The statement exceeded its ${deadlineMs} ms deadline.`,
                    }),
                  );
                }, deadlineMs);
          try {
            await promise;
          } finally {
            clearTimeout(timer);
          }
          break;
        }
      }
      return { rows: [{ id: 7, status: "open" }] };
    },
    releaseHeld: () => {
      for (const release of held.splice(0)) release();
    },
    signUps: [],
    unavailable: false,
    whenHeld: (count) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      onHold = () => {
        if (held.length >= count) resolve();
      };
      onHold();
      return promise;
    },
  };
  const logs: RequestLogEntry[] = [];
  const sessionEpoch = liveSessionEpoch(memory.database);
  const server = Bun.serve({
    fetch: createAppGateway({
      apps: gatewayApps,
      appsDomain: APPS_DOMAIN,
      currentSessionEpoch: sessionEpoch,
      database,
      identity: makePlatformSignIn({
        clientId: CLIENT_ID,
        issuer: ISSUER,
        oidc: makeOidcClient({
          clientId: CLIENT_ID,
          clientSecret: { current: async () => clientSecret, invalidate: () => undefined },
          fetch: identityServer.fetch,
          issuer: ISSUER,
          now,
          redirectUri,
        }),
        redirectUri,
      }),
      limits: apiCallLimits({
        callerShare: 4,
        total: 8,
        visitorShare: DEFAULT_VISITOR_LIMITS.callsPerApp,
        visitorTotal: 3,
        waitMs: 25,
      }),
      log: (entry) => logs.push(entry),
      lookups: cachedLookups({
        apps: gatewayApps,
        memberAccess: liveMemberAccess(memory.database),
        now,
        sessionEpoch,
        standing: standing.repository,
      }),
      now,
      random: systemRandom,
      releases: {
        document: async ({ appId, document, releaseId }) => {
          reads.push(document);
          return releases.get(`${appId}/${releaseId}/${document}`);
        },
      },
      visitors: {
        address: tokenBuckets({ limit: DEFAULT_VISITOR_LIMITS.address, now }),
        app: tokenBuckets({ limit: DEFAULT_VISITOR_LIMITS.app, now }),
        bodyMaxBytes: DEFAULT_VISITOR_LIMITS.bodyMaxBytes,
        deadlineMs: VISITOR_DEADLINE_MS,
        page: tokenBuckets({ limit: DEFAULT_VISITOR_LIMITS.page, now }),
      },
    }),
    port: 0,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const actor = { id: RUN, type: "agent" } as const;

  async function activeApp(input: {
    readonly access: AppAccessLevel;
    readonly name: string;
    readonly organizationId?: Ulid;
  }) {
    const created = await apps.createApp({
      actor,
      agentDefinitionId: AGENT,
      clusterKey: "default",
      createdBy: { principalId: null, runId: RUN },
      databaseLayout: 1,
      environmentId: ENVIRONMENT,
      name: input.name,
      organizationId: input.organizationId ?? ORGANIZATION,
      projectId: PROJECT,
      slug: slug(input.name.toLowerCase()),
      workspaceId: WORKSPACE,
    });
    const active = await apps.transitionApp({ actor, app: created, transition: { to: "active" } });
    return apps.setAccess({ app: active, changedBy: OWNER, organizationMembers: input.access });
  }

  async function release(
    app: AppRecord,
    content: string | Readonly<Record<string, string | null>> | undefined,
    promote: boolean,
  ) {
    const files = typeof content === "string" ? { "index.html": content } : (content ?? {});
    const created = await apps.createRelease({
      actor,
      app,
      bundleSha256: "a".repeat(64),
      bytes: 1_024,
      documents: Object.keys(files).filter(isReleaseDocumentFile).toSorted(),
      files: 2,
      releaseId: ids.generate(),
      runId: RUN,
    });
    for (const [path, body] of Object.entries(files)) {
      if (body !== null) releases.set(`${app.data.id}/${created.release.data.id}/${path}`, body);
    }
    const next = promote
      ? await apps.promoteRelease({ actor, app: created.app, releaseId: created.release.data.id })
      : created.app;
    return { app: next, releaseId: created.release.data.id };
  }

  function publication(app: AppRecord, next: Partial<AppPublication>) {
    return apps.setPublication({
      actor,
      app,
      database: { converge: async () => undefined, layout: 1 },
      publication: { ...app.data.publication, ...next },
    });
  }

  async function callback(browser: Browser, authorize: Response, principalId: Ulid) {
    const callbackQuery = identityServer.authorize(authorize.headers.get("location") ?? "", {
      principalId,
      sessionEpoch: 1,
    });
    identityServer.control.accessTokenOverrides = { sid: TOKEN_SESSION };
    identityServer.control.idTokenOverrides = {
      email: principalId === MEMBER ? "member@example.com" : "owner@example.com",
      email_verified: true,
    };
    return browser.request(
      "apex",
      `/_platform/auth/callback?${new URLSearchParams(callbackQuery).toString()}`,
    );
  }

  async function startSignIn(
    browser: Browser,
    site: AppRecord | CustomSite,
    principalId: Ulid,
    returnTo = "/orders?status=open",
  ): Promise<SignInStep> {
    const authorize = await browser.request(
      site,
      `/_platform/auth/login?return_to=${encodeURIComponent(returnTo)}`,
    );
    const returned = await callback(browser, authorize, principalId);
    const location = new URL(returned.headers.get("location") ?? "https://invalid");
    return {
      authorize,
      callback: returned,
      completePath: `${location.pathname}${location.search}`,
    };
  }

  async function signIn(browser: Browser, site: AppRecord | CustomSite, principalId: Ulid) {
    const step = await startSignIn(browser, site, principalId);
    return browser.request(site, step.completePath);
  }

  async function devToken(app: AppRecord, role: "editor" | "viewer") {
    const token = randomToken();
    await apps.createSession({
      appId: app.data.id,
      expiresAt: new Date(clock + 15 * 60 * 1_000),
      sessionId: sessionIdOf(token),
      subject: { kind: "agent-dev", role, runId: RUN },
    });
    return token;
  }

  async function signOutEverywhere(principalId: Ulid) {
    const identity = makeIdentityRepository(memory.database);
    const [security, fence] = await Promise.all([
      identity.securityStateForPrincipal(principalId),
      identity.bffFenceForPrincipal(principalId),
    ]);
    if (!security || !fence) throw new Error(`${principalId} has no security state.`);
    const updatedAt = now().toISOString();
    const sessionEpoch = security.data.sessionEpoch + 1;
    await identity.transact([
      {
        kind: "put",
        previousRecord: security,
        record: {
          ...security,
          data: { ...security.data, sessionEpoch, updatedAt, version: security.data.version + 1 },
        },
      },
      {
        kind: "put",
        previousRecord: fence,
        record: {
          ...fence,
          data: { ...fence.data, sessionEpoch, updatedAt, version: fence.data.version + 1 },
        },
      },
    ]);
  }

  return {
    activeApp,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    apps,
    holds: { place: standing.placeHold, release: standing.releaseHold },
    browser: (viewer = {}) => new Browser(origin, { address: "203.0.113.7", ...viewer }),
    callback,
    database,
    devToken,
    detachDomain: domains.detachDomain,
    domain: domains.domain,
    logs,
    persistenceCalls,
    reads,
    release,
    publish: (app, audience) => publication(app, { audience }),
    serve: (app, serving) => publication(app, { serving }),
    signIn,
    signOutEverywhere,
    startSignIn,
    stop: () => server.stop(true),
  };
}
