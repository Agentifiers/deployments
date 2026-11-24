import type { RouteResponse } from "../server/platform-api.ts";

type Approval = RouteResponse<"getApproval">;
type Message = RouteResponse<"listThreadMessages">["messages"][number];

export interface ApprovalRequestSummary {
  /**
   * Where the call would send data, each in full, when the organization's data boundary asks for
   * the approval; empty otherwise.
   */
  readonly destinations: readonly string[];
  readonly effect?: string;
  readonly inputSummary?: string;
  readonly requiredScopes: readonly string[];
  readonly toolName?: string;
}

export type MessageContent =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "external";
      readonly byteSize: number;
      readonly contentType: string;
      readonly expiresAt: string;
      readonly url: string;
    }
  | { readonly kind: "empty" };

function nonEmptyText(value: unknown) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function approvalRequestSummary(request: Approval["request"]): ApprovalRequestSummary {
  const effect = nonEmptyText(request.effect);
  const inputSummary = nonEmptyText(request.inputSummary);
  const toolName = nonEmptyText(request.toolName);
  const scopes = request.requiredScopes;
  const destinations = request.destinations;
  return {
    destinations: Array.isArray(destinations)
      ? destinations.filter((destination): destination is string => typeof destination === "string")
      : [],
    ...(effect ? { effect } : {}),
    ...(inputSummary ? { inputSummary } : {}),
    requiredScopes: Array.isArray(scopes)
      ? scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    ...(toolName ? { toolName } : {}),
  };
}

export function messageContent(message: Pick<Message, "body" | "bodyAccess">): MessageContent {
  if (message.body) return { kind: "text", text: message.body };
  if (message.bodyAccess) {
    const { byteSize, contentType, expiresAt, url } = message.bodyAccess;
    return { byteSize, contentType, expiresAt, kind: "external", url };
  }
  return { kind: "empty" };
}

const BYTE_UNITS = ["KiB", "MiB", "GiB"] as const;

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
