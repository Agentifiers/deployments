import { Option, Schema } from "effect";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { AppHostname, isPublishedAppDomain, type AppDomainRecord } from "../records/app-domains.ts";
import { SemanticEventRecord } from "../records/events.ts";
import { UniqueClaimRecord } from "../records/identity.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { appDomainDnsRecord } from "./domains.ts";
import { makeAppPersistence } from "./persistence.ts";
import {
  ADMIN,
  AGENT,
  ENVIRONMENT,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  PROJECT,
  RUN,
  START,
  WORKSPACE,
  slug,
} from "./test-support.ts";

export { OTHER_ORGANIZATION } from "./test-support.ts";

export const system = { type: "system" } as const;
export const owner = { id: ADMIN, type: "principal" } as const;
export const hostname = Schema.decodeUnknownSync(AppHostname);

export function harness(options: { readonly now?: () => Date } = {}) {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const [organizationId, name] of [
    [ORGANIZATION, "events-co"],
    [OTHER_ORGANIZATION, "forms-co"],
  ] as const) {
    fake.put(
      tables.control,
      withCanonicalRecordKeys({
        data: {
          createdAt: START,
          id: organizationId,
          name,
          slug: name,
          status: "active",
          updatedAt: START,
          version: 1,
        },
        itemType: "organization",
      }),
    );
  }
  const apps = makeAppPersistence({
    database: makeDynamoDatabase(fake.client, tables),
    generateId: makeIdGenerator().generate,
    now: options.now ?? (() => new Date(START)),
  });
  let appsCreated = 0;
  async function activeApp(organizationId = ORGANIZATION) {
    appsCreated += 1;
    const created = await apps.createApp({
      actor: { id: RUN, type: "agent" },
      agentDefinitionId: AGENT,
      clusterKey: "default",
      createdBy: { principalId: null, runId: RUN },
      databaseLayout: 1,
      environmentId: ENVIRONMENT,
      name: "Sign-up form",
      organizationId,
      projectId: PROJECT,
      slug: slug(`signup-${appsCreated}`),
      workspaceId: WORKSPACE,
    });
    return apps.transitionApp({ actor: system, app: created, transition: { to: "active" } });
  }
  function claims() {
    return fake
      .items(tables.control)
      .flatMap((item) => {
        const claim = Schema.decodeUnknownOption(UniqueClaimRecord)(item);
        return Option.isSome(claim) && claim.value.data.ownerItemType === "app-domain"
          ? [`${claim.value.data.namespace}=${claim.value.data.value}`]
          : [];
      })
      .sort();
  }
  function domainEvents() {
    return fake.items(tables.events).flatMap((item) => {
      const event = Schema.decodeUnknownOption(SemanticEventRecord)(item);
      return Option.isSome(event) && event.value.data.aggregateType === "app-domain"
        ? [
            {
              payload: event.value.data.payload,
              type: event.value.data.eventType,
              version: event.value.data.aggregateVersion,
            },
          ]
        : [];
    });
  }
  async function published(name: string, organizationId?: Ulid) {
    const app = await activeApp(organizationId);
    const attached = await apps.attachDomain({ actor: owner, app, hostname: hostname(name) });
    const verified = await apps.verifyDomain({
      actor: owner,
      app,
      domain: attached,
      observeTxt: publishing([attached]).observeTxt,
    });
    if (!isPublishedAppDomain(verified)) throw new Error("Expected a verified domain.");
    return { app, verified };
  }
  return { activeApp, apps, claims, domainEvents, fake, published, tables };
}

export function publishing(domains: readonly AppDomainRecord[]) {
  const observed: string[] = [];
  const proofs = domains.map((domain) => appDomainDnsRecord(domain.data));
  return {
    observeTxt: async (name: string) => {
      observed.push(name);
      return [
        "v=spf1 -all",
        ...proofs.flatMap((proof) => (proof.name === name ? [proof.value] : [])),
      ];
    },
    observed,
  };
}
