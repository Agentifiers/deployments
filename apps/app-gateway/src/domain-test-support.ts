import {
  appDomainDnsRecord,
  AppDomainRecord,
  AppHostname,
  type AppDomainState,
  type AppPersistence,
  type AppRecord,
  type Ulid,
} from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db/records";
import { Schema } from "effect";
import type { CustomSite } from "./test-support.ts";

const appHostname = Schema.decodeUnknownSync(AppHostname);
const decodeDomain = Schema.decodeUnknownSync(AppDomainRecord);

type DomainAttacher = "api-key" | "person";

export interface DomainFixture {
  readonly detachDomain: (domain: AppDomainRecord) => Promise<void>;
  readonly domain: (input: {
    readonly app: AppRecord;
    readonly attachedBy: DomainAttacher;
    readonly hostname: string;
    readonly state: AppDomainState["kind"];
  }) => Promise<{ readonly domain: AppDomainRecord; readonly site: CustomSite }>;
}

/**
 * Only the domain reconciler moves a domain to `active`, so the fixture marks a verified domain
 * active in the view the gateway reads rather than in the table.
 */
export function domainFixture(input: {
  readonly apps: AppPersistence;
  readonly automation: Ulid;
  readonly now: () => Date;
  readonly person: Ulid;
}): DomainFixture & Pick<AppPersistence, "domainForHostname"> {
  const { apps } = input;
  const attachers = {
    "api-key": { id: input.automation, type: "service-account" },
    person: { id: input.person, type: "principal" },
  } as const;
  const owner = attachers.person;
  const activatedAt = new Map<Ulid, string>();

  return {
    async detachDomain(domain) {
      const app = await apps.getApp(domain.data.appId);
      if (!app) throw new Error(`App ${domain.data.appId} is gone.`);
      await apps.detachDomain({ actor: owner, app, domain });
    },

    async domain({ app, attachedBy, hostname, state }) {
      const attached = await apps.attachDomain({
        actor: attachers[attachedBy],
        app,
        hostname: appHostname(hostname),
      });
      const site = { app, hostname };
      if (state === "unverified") return { domain: attached, site };
      const proof = appDomainDnsRecord(attached.data);
      const verified = await apps.verifyDomain({
        actor: owner,
        app,
        domain: attached,
        observeTxt: async (name) => (name === proof.name ? [proof.value] : []),
      });
      if (state === "active") activatedAt.set(verified.data.id, input.now().toISOString());
      return { domain: verified, site };
    },

    async domainForHostname(hostname) {
      const stored = await apps.domainForHostname(hostname);
      const at = stored && activatedAt.get(stored.data.id);
      if (!at || stored.data.state.kind !== "verified") return stored;
      return decodeDomain(
        withCanonicalRecordKeys({
          data: {
            ...stored.data,
            state: { ...stored.data.state, activatedAt: at, kind: "active" },
          },
          itemType: "app-domain",
        }),
      );
    },
  };
}
