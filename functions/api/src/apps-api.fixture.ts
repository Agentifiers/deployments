import {
  AgentDefinitionRecord,
  AppSlug,
  SemanticEventRecord,
  Ulid,
  makeAppPersistence,
  makeDynamoDatabase,
  makeIdGenerator,
  makeTenancyPersistence,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type AppRecord,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import { Schema } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { lambdaAppDomainReconcile } from "./app-domain-reconciler-client.ts";
import { appsApiFromEnvironment, createAppsApi, type CreateAppsApiOptions } from "./apps-api.ts";
import { lambdaAppsDatabase } from "./apps-database-client.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
export const OWNER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA0");
export const ADMIN = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA1");
export const MEMBER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA2");
export const OUTSIDER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA3");
export const RUN = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA4");
const AGENT = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA5");
const WORKSPACE = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA6");
export const SERVICE_ACCOUNT = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA7");
export const NEXT_AGENT = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA8");
export const MISSING_AGENT = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA9");
export const FIRST_RELEASE = ulid("01ARZ3NDEKTSV4RRFFQ69G5FB1");
export const SECOND_RELEASE = ulid("01ARZ3NDEKTSV4RRFFQ69G5FB2");
export const STAGING_RELEASE = ulid("01ARZ3NDEKTSV4RRFFQ69G5FB3");
const VIEWER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FB4");
export const START = "2026-10-08T12:00:00.000Z";
export const ROUTING_ENDPOINT = "d111111abcdef8.cloudfront.net";

export interface AppsApiAnswer {
  readonly body: Record<string, unknown>;
  readonly retryAfter?: string;
  readonly status: number;
}

export type AppsApiSend = (
  caller: string,
  method: string,
  path: string,
  options?: { readonly body?: unknown; readonly environmentId?: Ulid },
) => Promise<AppsApiAnswer>;

let sequence = 0;
const nextKey = () => `seed-${++sequence}`;

function agentDefinition(scope: {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}) {
  return Schema.decodeUnknownSync(AgentDefinitionRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        createdAt: START,
        createdByPrincipalId: OWNER,
        draft: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "Agent",
          metadata: { key: "example.builder", name: "Builder", version: "1.0.0" },
          spec: {
            instructions: "Build internal tools.",
            model: { id: "openai/gpt-4o" },
            sandbox: { mode: "none" },
          },
        },
        id: NEXT_AGENT,
        name: "Builder",
        slug: "builder",
        status: "active",
        updatedAt: START,
        version: 1,
        workspaceId: WORKSPACE,
      },
      itemType: "agent-definition" as const,
    }),
  );
}

export async function appsApiHarness() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const [principalId, email] of [
    [OWNER, "owner@acme.example"],
    [ADMIN, "admin@acme.example"],
    [MEMBER, "member@acme.example"],
    [VIEWER, "viewer@acme.example"],
    [OUTSIDER, "outsider@rival.example"],
  ] as const) {
    fake.put(tables.control, humanPrincipalRecord(principalId, email));
  }
  const database = makeDynamoDatabase(fake.client, tables);
  const tenancy = makeTenancyPersistence({ database });
  const founder = { principalId: OWNER, scopes: ["platform:*"] };
  const organization = await tenancy.organizations.create({
    body: { name: "Acme" },
    identity: founder,
    idempotencyKey: nextKey(),
    query: {},
    scope: {},
  });
  const organizationId = ulid(organization.id);
  for (const [principalId, role] of [
    [ADMIN, "admin"],
    [MEMBER, "member"],
    [VIEWER, "viewer"],
  ] as const) {
    await tenancy.organizationMembers.add({
      body: { principalId, role },
      identity: founder,
      idempotencyKey: nextKey(),
      query: {},
      scope: { organizationId },
    });
  }
  const project = await tenancy.projects.create({
    body: { name: "Back office" },
    identity: founder,
    idempotencyKey: nextKey(),
    query: {},
    scope: { organizationId },
  });
  const projectId = ulid(project.id);
  const environment = async (name: string, type: "production" | "staging") =>
    ulid(
      (
        await tenancy.environments.create({
          body: { name, type },
          identity: founder,
          idempotencyKey: nextKey(),
          query: {},
          scope: { organizationId, projectId },
        })
      ).id,
    );
  const production = await environment("Production", "production");
  const staging = await environment("Staging", "staging");
  fake.put(
    tables.control,
    agentDefinition({ environmentId: production, organizationId, projectId }),
  );

  let clock = Date.parse(START);
  const apps = makeAppPersistence({
    database,
    generateId: makeIdGenerator().generate,
    now: () => new Date(clock),
  });
  const provisioningApp = (environmentId: Ulid, slug: string, name: string) =>
    apps.createApp({
      actor: { id: RUN, type: "agent" },
      agentDefinitionId: AGENT,
      clusterKey: "default",
      createdBy: { principalId: null, runId: RUN },
      databaseLayout: 1,
      environmentId,
      name,
      organizationId,
      projectId,
      slug: Schema.decodeUnknownSync(AppSlug)(slug),
      workspaceId: WORKSPACE,
    });
  const activeApp = async (
    environmentId: Ulid,
    slug: string,
    name: string,
    releaseIds: readonly Ulid[],
  ) => {
    let app: AppRecord = await apps.transitionApp({
      actor: { type: "system" },
      app: await provisioningApp(environmentId, slug, name),
      transition: { to: "active" },
    });
    for (const releaseId of releaseIds) {
      ({ app } = await apps.createRelease({
        actor: { id: RUN, type: "agent" },
        app,
        bundleSha256: "a".repeat(64),
        bytes: 2_048,
        documents: ["index.html"],
        files: 3,
        releaseId,
        runId: RUN,
      }));
    }
    return app;
  };
  const payroll = await activeApp(production, "payroll", "Payroll", [
    FIRST_RELEASE,
    SECOND_RELEASE,
  ]);
  const roster = await activeApp(staging, "roster", "Roster", [STAGING_RELEASE]);

  const human = (
    principalId: Ulid,
    organizationRole: "admin" | "member" | "owner" | "viewer",
  ): ApiIdentity => ({
    authentication: "tenant-jwt",
    organizationIds: [organizationId],
    organizationRole,
    principalId,
    scopes: ["apps:read", "apps:write", "apps:publish"],
  });
  const key = (scopes: readonly string[]): ApiIdentity => ({
    apiCredentialId: "credential-1",
    authentication: "api-credential",
    environmentIds: [production],
    organizationIds: [organizationId],
    principalId: SERVICE_ACCOUNT,
    projectIds: [projectId],
    scopes,
  });
  const identities: Readonly<Record<string, ApiIdentity>> = {
    admin: human(ADMIN, "admin"),
    key: key(["apps:read", "apps:write", "apps:publish"]),
    "platform key": key(["platform:*"]),
    "publish key": key(["apps:read", "apps:publish"]),
    "wildcard key": key(["apps:*"]),
    member: human(MEMBER, "member"),
    owner: human(OWNER, "owner"),
    reader: { ...human(OWNER, "owner"), scopes: ["apps:read"] },
    viewer: human(VIEWER, "viewer"),
  };
  const appsDatabase = {
    invocations: [] as {
      readonly appId: string;
      readonly op: string;
      readonly slug: string;
    }[],
    nextOutcome: "succeeds" as "crashes" | "outlives its deadline" | "succeeds",
  };
  const dns = {
    failing: false,
    lookups: [] as string[],
    txt: new Map<string, string[][]>(),
  };
  const domainReconciler = {
    invocations: [] as {
      readonly invocationType: string;
      readonly payload: unknown;
    }[],
    nextOutcome: "succeeds" as "fails" | "succeeds",
  };
  const replayed: string[] = [];
  const authenticate: CreateAppsApiOptions["authenticate"] = async (request) =>
    identities[request.headers.get("authorization") ?? ""] ?? null;
  const idempotency: CreateAppsApiOptions["idempotency"] = {
    execute: async (input) => {
      replayed.push(input.key);
      return input.operation();
    },
  };
  const handler = createAppsApi({
    appDomains: {
      reconcile: lambdaAppDomainReconcile({
        client: {
          send: async (command) => {
            const payload: unknown = JSON.parse(
              new TextDecoder().decode(command.input.Payload as Uint8Array),
            );
            const invocationType = command.input.InvocationType ?? "RequestResponse";
            domainReconciler.invocations.push({ invocationType, payload });
            const outcome = domainReconciler.nextOutcome;
            domainReconciler.nextOutcome = "succeeds";
            if (outcome === "fails") throw new Error("Rate exceeded");
            return {};
          },
        },
        deadlineMs: 1_000,
        functionName: "apps-domains",
      }),
      reservedHostnames: ["api.example.test", "console.example.test"],
      resolveTxt: async (name) => {
        dns.lookups.push(name);
        const records = dns.txt.get(name);
        if (dns.failing || !records) {
          throw Object.assign(new Error(`queryTxt failed ${name}`), {
            code: dns.failing ? "ETIMEOUT" : "ENOTFOUND",
          });
        }
        return records;
      },
      routingEndpoint: ROUTING_ENDPOINT,
    },
    apps,
    appsDatabase: lambdaAppsDatabase({
      client: {
        send: async (command, handlerOptions) => {
          const { appId, op, slug } = JSON.parse(
            new TextDecoder().decode(command.input.Payload as Uint8Array),
          ) as {
            readonly appId: string;
            readonly op: string;
            readonly slug: string;
          };
          appsDatabase.invocations.push({ appId, op, slug });
          const outcome = appsDatabase.nextOutcome;
          appsDatabase.nextOutcome = "succeeds";
          if (outcome === "outlives its deadline") {
            const { promise, reject } = Promise.withResolvers<never>();
            handlerOptions.abortSignal?.addEventListener("abort", () => {
              reject(new Error("Request aborted"));
            });
            return promise;
          }
          const envelope =
            outcome === "crashes"
              ? { error: { code: "internal_error", message: "connection timeout" }, ok: false }
              : { ok: true, value: { appId } };
          return { Payload: new TextEncoder().encode(JSON.stringify(envelope)) };
        },
      },
      deadlineMs: 5,
      functionName: "apps-database",
    }),
    appsDomain: "apps.example.test",
    authenticate,
    idempotency,
    requestId: () => "req-test",
    tenancy,
  });
  const sender =
    (api: (request: Request) => Promise<Response | undefined>): AppsApiSend =>
    async (caller, method, path, options = {}) => {
      const response = await api(
        new Request(`https://api.example.test${path}`, {
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          headers: {
            authorization: caller,
            "x-deployments-environment": options.environmentId ?? production,
            ...(method === "GET" ? {} : { "idempotency-key": `request-${++sequence}` }),
          },
          method,
        }),
      );
      if (!response) throw new Error(`No route handled ${method} ${path}`);
      const retryAfter = response.headers.get("retry-after");
      return {
        body: (await response.json()) as Record<string, unknown>,
        ...(retryAfter === null ? {} : { retryAfter }),
        status: response.status,
      };
    };
  const fromEnvironment = (environment: NodeJS.ProcessEnv) => {
    const api = appsApiFromEnvironment({
      authenticate,
      database,
      environment,
      idempotency,
      tenancy,
    });
    return api && sender(api);
  };
  const payrollBody = {
    access: { organizationMembers: "none" },
    agentDefinitionId: AGENT,
    createdAt: START,
    createdBy: { principalId: null, runId: RUN },
    environmentId: production,
    id: payroll.data.id,
    lifecycle: { liveReleaseId: null, state: "active" },
    name: "Payroll",
    organizationId,
    projectId,
    publication: { audience: "members", serving: "single-page" },
    slug: "payroll",
    updatedAt: START,
    url: "https://payroll.apps.example.test",
    workspaceId: WORKSPACE,
  };
  return {
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    apps,
    appsDatabase,
    dns,
    domainReconciler,
    eventsOf: (eventType: string) =>
      fake
        .items(tables.events)
        .filter((item) => item.itemType === "semantic-event")
        .map((item) => Schema.decodeUnknownSync(SemanticEventRecord)(item).data)
        .filter((event) => event.eventType === eventType)
        .map(({ actor, payload }) => ({ actor, payload })),
    fromEnvironment,
    payroll,
    payrollBody,
    production,
    provisioningApp,
    replayed,
    roster,
    send: sender(handler),
    staging,
  };
}
