import type { RouteTab } from "../components/route-tabs.tsx";
import { oneOf } from "../observability/range.ts";
import type { RouteResponse } from "../server/platform-api.ts";

export type AgentEmailInbox = RouteResponse<"getAgentEmailInbox">;
export type InboxStatus = AgentEmailInbox["status"];
export type AgentEmailBinding = RouteResponse<"getAgentEmailBinding">;

export const INBOX_STATUSES = [
  "active",
  "paused",
  "archived",
] as const satisfies readonly InboxStatus[];

export interface InboxSearch {
  readonly status?: InboxStatus;
}

export function parseInboxSearch(search: Readonly<Record<string, unknown>>): InboxSearch {
  const status = oneOf(INBOX_STATUSES, search.status);
  return status === undefined ? {} : { status };
}

export type InboxAction = "archive" | "pause" | "resume";

export const INBOX_ACTIONS: Readonly<Record<InboxStatus, readonly InboxAction[]>> = {
  active: ["pause", "archive"],
  archived: [],
  paused: ["resume", "archive"],
};

export const INBOX_STATUS_AFTER: Readonly<Record<InboxAction, InboxStatus>> = {
  archive: "archived",
  pause: "paused",
  resume: "active",
};

export const INBOX_TABS: readonly { readonly label: string; readonly segment: string }[] = [
  { label: "Overview", segment: "" },
  { label: "Threads", segment: "threads" },
  { label: "Messages", segment: "messages" },
  { label: "Drafts", segment: "drafts" },
];

export function inboxTabs(basePath: string, pathname: string): readonly RouteTab[] {
  return INBOX_TABS.map(({ label, segment }) => {
    const href = segment === "" ? basePath : `${basePath}/${segment}`;
    return {
      current:
        segment === ""
          ? pathname === basePath || pathname === `${basePath}/`
          : pathname === href || pathname.startsWith(`${href}/`),
      href,
      label,
    };
  });
}

export interface InboxDraft {
  readonly domainId: string;
  readonly localPart: string;
  readonly name: string;
}

export interface InboxBody {
  readonly domainId?: string;
  readonly localPart?: string;
  readonly name?: string;
}

const LOCAL_PART = /^[^\s@]{1,64}$/u;

export function readInboxDraft(
  draft: InboxDraft,
):
  | { readonly ok: true; readonly body: InboxBody }
  | { readonly ok: false; readonly message: string } {
  const name = draft.name.trim();
  const localPart = draft.localPart.trim().toLowerCase();
  if (name.length > 120) return { message: "Names are at most 120 characters.", ok: false };
  if (localPart !== "" && !LOCAL_PART.test(localPart)) {
    return {
      message: "The local part is the text before @, with no spaces, up to 64 characters.",
      ok: false,
    };
  }
  return {
    body: {
      ...(draft.domainId === "" ? {} : { domainId: draft.domainId }),
      ...(localPart === "" ? {} : { localPart }),
      ...(name === "" ? {} : { name }),
    },
    ok: true,
  };
}

export type BindingDraft =
  | { readonly bindingType: "platform_agent"; readonly agentDeploymentId: string }
  | { readonly bindingType: "external"; readonly externalId: string };

export function readBindingDraft(draft: BindingDraft): BindingDraft | undefined {
  if (draft.bindingType === "platform_agent") {
    return draft.agentDeploymentId === "" ? undefined : draft;
  }
  const externalId = draft.externalId.trim();
  return externalId === "" || externalId.length > 512
    ? undefined
    : { bindingType: "external", externalId };
}
