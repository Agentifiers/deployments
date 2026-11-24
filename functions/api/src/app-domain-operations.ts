import { AttachAppDomainRequest } from "@deployments-ai/api-contract";
import {
  AppHostname,
  appDomainDnsRecord,
  type AppDomainRecord,
  type AppPersistence,
  type AppRecord,
  type ObserveTxt,
  type Ulid,
} from "@deployments-ai/db";
import { Option, Schema } from "effect";
import type {
  AppsEnvironment,
  AppsPublishInvocation,
  AppsReadInvocation,
} from "./apps-operations.ts";
import type { AppDomainReconcile } from "./app-domain-reconciler-client.ts";
import { AppsProblem } from "./apps-problem.ts";
import { errorLogFields } from "./error-log-fields.ts";

export interface AppDomainSettings {
  readonly installationHostnames: readonly string[];
  readonly observeTxt: ObserveTxt;
  readonly reconcile: AppDomainReconcile;
  readonly routingEndpoint: string;
}

const APEX_NOTE =
  "A zone apex cannot hold a CNAME; publish an ALIAS or ANAME record, or use CNAME flattening.";

const decodeAttach = Schema.decodeUnknownSync(AttachAppDomainRequest, {
  onExcessProperty: "error",
});
const decodeHostname = Schema.decodeUnknownOption(AppHostname);

export function parseAppHostname(input: string, installationHostnames: readonly string[]) {
  const hostname = decodeHostname(input.trim().toLowerCase());
  if (Option.isNone(hostname)) {
    throw new AppsProblem(
      422,
      "invalid_hostname",
      "Hostnames are ASCII names (punycode for others) with at least two labels, at most 236 characters so the TXT proof name fits in DNS, and no IP addresses.",
    );
  }
  const reserved = installationHostnames.find(
    (installation) =>
      hostname.value === installation || hostname.value.endsWith(`.${installation}`),
  );
  if (reserved) {
    throw new AppsProblem(
      422,
      "hostname_reserved",
      `${hostname.value} is ${reserved} or under it, which this installation serves.`,
    );
  }
  return hostname.value;
}

export function makeAppDomainOperations(dependencies: {
  readonly apps: AppPersistence;
  readonly appIn: (
    environment: AppsEnvironment,
    params: Readonly<Record<string, Ulid>>,
  ) => Promise<AppRecord>;
  readonly settings: AppDomainSettings;
}) {
  const { apps, appIn, settings } = dependencies;

  function domainResponse({ data }: AppDomainRecord) {
    const txt = appDomainDnsRecord(data);
    const { state } = data;
    return {
      appId: data.appId,
      attachedBy: {
        id: data.attachedBy.id,
        principal: data.attachedBy.type === "service-account" ? "service-account" : "human",
      },
      createdAt: data.createdAt,
      dnsRecords: [
        { name: txt.name, type: txt.type, value: txt.value },
        { name: data.hostname, note: APEX_NOTE, type: "CNAME", value: settings.routingEndpoint },
      ],
      hostname: data.hostname,
      id: data.id,
      state:
        state.kind === "unverified"
          ? state
          : {
              ...(state.kind === "active" ? { activatedAt: state.activatedAt } : {}),
              kind: state.kind,
              problem: state.problem && {
                code: state.problem.code,
                message: state.problem.message,
                observedAt: state.problem.observedAt,
              },
              verifiedAt: state.verifiedAt,
            },
      updatedAt: data.updatedAt,
    };
  }

  async function domainIn({ environment, params }: AppsPublishInvocation) {
    const app = await appIn(environment, params);
    const domainId = params["domainId"];
    const domain = domainId ? await apps.getDomain({ app, domainId }) : undefined;
    if (!domain) throw new AppsProblem(404, "domain_not_found", "The app has no such domain.");
    return { app, domain };
  }

  /** The scheduled run converges every domain, so a failed request only delays the edge. */
  async function reconcile(domain: AppDomainRecord, options: { readonly refresh: boolean }) {
    try {
      await settings.reconcile(domain, options);
    } catch (cause) {
      console.error("App domain reconciliation request failed.", {
        ...errorLogFields(cause),
        domainId: domain.data.id,
      });
    }
  }

  return {
    read: {
      async listAppDomains({ environment, params, query }: AppsReadInvocation) {
        const app = await appIn(environment, params);
        const page = await apps.pageDomains({ app, ...query });
        return { items: page.items.map(domainResponse), nextCursor: page.nextCursor };
      },
    },
    publish: {
      async attachAppDomain({ actor, body, environment, params }: AppsPublishInvocation) {
        const hostname = parseAppHostname(
          decodeAttach(body).hostname,
          settings.installationHostnames,
        );
        const app = await appIn(environment, params);
        return domainResponse(await apps.attachDomain({ actor, app, hostname }));
      },
      async refreshAppDomain(invocation: AppsPublishInvocation) {
        const { app, domain } = await domainIn(invocation);
        const verified = await apps.verifyDomain({
          actor: invocation.actor,
          app,
          domain,
          observeTxt: settings.observeTxt,
        });
        await reconcile(verified, { refresh: true });
        return domainResponse(verified);
      },
      async detachAppDomain(invocation: AppsPublishInvocation) {
        const { app, domain } = await domainIn(invocation);
        await apps.detachDomain({ actor: invocation.actor, app, domain });
        if (domain.data.state.kind !== "unverified") {
          await reconcile(domain, { refresh: false });
        }
        return domainResponse(domain);
      },
    },
  };
}
