import type { ConsoleOperation, OperationAccess } from "../access.ts";
import type { RouteTab } from "../components/route-tabs.tsx";

interface EmailTab {
  readonly gate: ConsoleOperation;
  /** Shown only where customers run their own sending infrastructure. */
  readonly sendingInfrastructure?: true;
  readonly label: string;
  readonly segments: readonly [string, ...string[]];
}

const EMAIL_TABS: readonly EmailTab[] = [
  {
    gate: "listAgentEmailInboxes",
    label: "Inboxes",
    segments: ["", "inboxes", "bindings", "messages", "drafts"],
  },
  { gate: "listAgentEmailDomains", label: "Domains", segments: ["domains"] },
  {
    gate: "listAgentEmailPlacements",
    label: "Placements",
    segments: ["placements"],
    sendingInfrastructure: true,
  },
  { gate: "getAgentEmailPolicy", label: "Policy", segments: ["policy"] },
  { gate: "listAgentEmailSuppressions", label: "Suppressions", segments: ["suppressions"] },
  { gate: "getAgentEmailUsage", label: "Usage", segments: ["usage"] },
  {
    gate: "listEmailTenants",
    label: "Sending tenants",
    segments: ["tenants", "tenant-domains"],
    sendingInfrastructure: true,
  },
];

export function emailTabs(
  emailPath: string,
  pathname: string,
  access: OperationAccess,
  managesSending: boolean,
): readonly RouteTab[] {
  const [segment = ""] = pathname.slice(emailPath.length + 1).split("/");
  return EMAIL_TABS.filter(
    (tab) => access[tab.gate] && (managesSending || !tab.sendingInfrastructure),
  ).map((tab) => ({
    current: tab.segments.includes(segment),
    href: tab.segments[0] === "" ? emailPath : `${emailPath}/${tab.segments[0]}`,
    label: tab.label,
  }));
}
