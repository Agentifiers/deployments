import { describe, expect, test } from "bun:test";
import { PublicId, Slug } from "@deployments-ai/api-contract/primitives";
import { CreditCardIcon } from "@hugeicons/core-free-icons";
import { Schema } from "effect";
import { operationAccess } from "./access.ts";
import { memberInitials } from "./components/organization-shell.tsx";
import { DEFAULT_CONSOLE_EDITION, type ConsoleEdition } from "./edition.ts";
import { organizationPageTitle, systemPageTitle } from "./page-title.ts";
import type { OrganizationShell } from "./server/console-data.ts";

const AT = "2026-10-09T12:00:00.000Z";
const id = Schema.decodeUnknownSync(PublicId);
const slug = Schema.decodeUnknownSync(Slug);
const ORG = id("01K000000000000000000000G1");
const PRJ = id("01K000000000000000000000P1");
const ENV = id("01K000000000000000000000E1");
const MANAGED: ConsoleEdition = {
  hiddenRoutes: [],
  install: "managed",
  organizationNavigation: [
    {
      href: (organizationId) => `/o/${organizationId}/billing`,
      icon: CreditCardIcon,
      label: "Billing",
    },
  ],
  productName: "Deployments.ai",
};

const shell: OrganizationShell = {
  access: operationAccess({ capabilities: [], organizationRole: "member" }),
  authorization: { capabilities: [], organizationRole: "member" },
  organization: {
    createdAt: AT,
    id: ORG,
    name: "Acme",
    slug: slug("acme"),
    status: "active",
    updatedAt: AT,
  },
  organizations: [],
  principalId: "prn1",
  projects: [
    {
      environments: [
        {
          createdAt: AT,
          id: ENV,
          name: "Production",
          organizationId: ORG,
          projectId: PRJ,
          slug: slug("production"),
          status: "active",
          type: "production",
          updatedAt: AT,
        },
      ],
      project: { id: PRJ, name: "Support", slug: slug("support"), status: "active" },
    },
  ],
};

const ORGANIZATION = `/o/${ORG}`;
const PROJECT = `${ORGANIZATION}/p/${PRJ}`;
const ENVIRONMENT = `${PROJECT}/e/${ENV}`;

const title = (pathname: string, edition: ConsoleEdition = DEFAULT_CONSOLE_EDITION) =>
  organizationPageTitle({ edition, pathname, shell });

describe("page titles", () => {
  test("name an environment page by its sidebar item and environment", () => {
    expect(title(`${ENVIRONMENT}/agents`)).toBe("Agents · Production · Deployments.ai Console");
    expect(title(`${ENVIRONMENT}/agents/agt1/tools/`, MANAGED)).toBe(
      "Agents · Production · Deployments.ai",
    );
    expect(title(ENVIRONMENT)).toBe("Overview · Production · Deployments.ai Console");
  });

  test("name an organization page by its sidebar item, the host's pages included", () => {
    expect(title(`${ORGANIZATION}/members`)).toBe("Members · Acme · Deployments.ai Console");
    expect(title(`${ORGANIZATION}/billing/plans`, MANAGED)).toBe("Billing · Acme · Deployments.ai");
    expect(title(ORGANIZATION)).toBe("Overview · Acme · Deployments.ai Console");
  });

  test("fall back to the organization for a page the sidebar does not list", () => {
    expect(title(`${PROJECT}/settings`)).toBe("Acme · Deployments.ai Console");
    expect(title(`${PROJECT}/e/unknown/agents`)).toBe("Acme · Deployments.ai Console");
  });

  test("name a system page by its sidebar item", () => {
    const system = (pathname: string) =>
      systemPageTitle({ edition: DEFAULT_CONSOLE_EDITION, pathname });
    expect(system("/system")).toBe("Overview · System · Deployments.ai Console");
    expect(system("/system/people/prn1")).toBe("People · System · Deployments.ai Console");
  });
});

describe("member initials", () => {
  test("come from the display name, then the email, then fall back to Me", () => {
    expect(memberInitials({ displayName: "Ada Byron Lovelace" })).toBe("AL");
    expect(memberInitials({ displayName: "ada", primaryEmail: "x@y.z" })).toBe("A");
    expect(memberInitials({ displayName: " ", primaryEmail: "grace.hopper@navy.mil" })).toBe("GH");
    expect(memberInitials({ primaryEmail: "linus@kernel.org" })).toBe("L");
    expect(memberInitials(undefined)).toBe("Me");
  });
});
