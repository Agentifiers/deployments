import {
  EMAIL_API_ROUTES as PUBLIC_EMAIL_API_ROUTES,
  type EmailApiRouteName,
} from "@deployments-ai/api-contract/email";
import type {
  AgentEmailApiOperation,
  AgentEmailApiPermission,
  AgentEmailApiRoute,
} from "./api-handler.ts";

type BodyMode = AgentEmailApiRoute["body"];

export type EmailApiOperation = EmailApiRouteName;

export const EMAIL_API_ROUTES: readonly AgentEmailApiRoute[] = PUBLIC_EMAIL_API_ROUTES.map(
  (route) => ({
    body: route.requestBody ? "required" : "none",
    idempotent: route.idempotency === "required",
    method: route.method,
    operation: route.name,
    path: route.path,
    permission: route.requiredAuthorization,
    successStatus: route.successStatus,
  }),
);

const emailOperations: Readonly<Record<string, true>> = Object.fromEntries(
  EMAIL_API_ROUTES.map((route) => [route.operation, true as const]),
);

export function isEmailApiOperation(
  operation: AgentEmailApiOperation,
): operation is EmailApiOperation {
  return emailOperations[operation] === true;
}
const read = (
  operation: AgentEmailApiOperation,
  path: string,
  body: BodyMode = "none",
): AgentEmailApiRoute => ({
  body,
  idempotent: false,
  method: body === "none" ? "GET" : "POST",
  operation,
  path,
  permission: "agent-email:read",
  successStatus: 200,
});

const write = (
  operation: AgentEmailApiOperation,
  method: "DELETE" | "PATCH" | "POST",
  path: string,
  body: BodyMode,
  successStatus: 200 | 201 | 202 = 200,
  permission: AgentEmailApiPermission = "agent-email:write",
): AgentEmailApiRoute => ({
  body,
  idempotent: true,
  method,
  operation,
  path,
  permission,
  successStatus,
});

const readPost = (
  operation: AgentEmailApiOperation,
  path: string,
  body: BodyMode = "none",
): AgentEmailApiRoute => ({
  body,
  idempotent: false,
  method: "POST",
  operation,
  path,
  permission: "agent-email:read",
  successStatus: 200,
});

export const AGENT_EMAIL_API_ROUTES = Object.freeze([
  write("createInbox", "POST", "/v1/agent-email/inboxes", "required", 201),
  read("listInboxes", "/v1/agent-email/inboxes"),
  read("getInbox", "/v1/agent-email/inboxes/:inboxId"),
  write("updateInbox", "PATCH", "/v1/agent-email/inboxes/:inboxId", "required"),
  write("createBinding", "POST", "/v1/agent-email/inboxes/:inboxId/bindings", "required", 201),
  read("listBindings", "/v1/agent-email/inboxes/:inboxId/bindings"),
  read("getBinding", "/v1/agent-email/bindings/:bindingId"),
  write("deleteBinding", "DELETE", "/v1/agent-email/bindings/:bindingId", "none"),
  write("sendInboxMessage", "POST", "/v1/agent-email/inboxes/:inboxId/messages", "required", 202),
  read("listInboxMessages", "/v1/agent-email/inboxes/:inboxId/messages"),
  read("searchInboxMessages", "/v1/agent-email/inboxes/:inboxId/messages/search", "required"),
  read("getMessage", "/v1/agent-email/messages/:messageId"),
  write("replyMessage", "POST", "/v1/agent-email/messages/:messageId/reply", "required", 202),
  write(
    "replyAllMessage",
    "POST",
    "/v1/agent-email/messages/:messageId/reply-all",
    "required",
    202,
  ),
  write("forwardMessage", "POST", "/v1/agent-email/messages/:messageId/forward", "required", 202),
  readPost("createRawMessageAccess", "/v1/agent-email/messages/:messageId/raw/access"),
  write(
    "reprocessRawMessage",
    "POST",
    "/v1/agent-email/messages/:messageId/raw/reprocess",
    "none",
    202,
    "agent-email:admin",
  ),
  readPost("createAttachmentAccessUrl", "/v1/agent-email/attachments/:attachmentId/access-url"),
  read("listInboxThreads", "/v1/agent-email/inboxes/:inboxId/threads"),
  read("searchInboxThreads", "/v1/agent-email/inboxes/:inboxId/threads/search", "required"),
  read("getInboxThread", "/v1/agent-email/inboxes/:inboxId/threads/:threadId"),
  write("createDomain", "POST", "/v1/agent-email/domains", "required", 201, "agent-email:admin"),
  read("listDomains", "/v1/agent-email/domains"),
  read("getDomain", "/v1/agent-email/domains/:domainId"),
  write(
    "refreshDomain",
    "POST",
    "/v1/agent-email/domains/:domainId/refresh",
    "none",
    200,
    "agent-email:admin",
  ),
  write(
    "revokeDomain",
    "POST",
    "/v1/agent-email/domains/:domainId/revoke",
    "none",
    200,
    "agent-email:admin",
  ),
  write(
    "createPlacement",
    "POST",
    "/v1/agent-email/placements",
    "required",
    201,
    "agent-email:admin",
  ),
  read("listPlacements", "/v1/agent-email/placements"),
  read("getPlacement", "/v1/agent-email/placements/:placementId"),
  write(
    "updatePlacement",
    "PATCH",
    "/v1/agent-email/placements/:placementId",
    "required",
    200,
    "agent-email:admin",
  ),
  write("createDraft", "POST", "/v1/agent-email/inboxes/:inboxId/drafts", "required", 201),
  read("listInboxDrafts", "/v1/agent-email/inboxes/:inboxId/drafts"),
  read("getDraft", "/v1/agent-email/drafts/:draftId"),
  write("updateDraft", "PATCH", "/v1/agent-email/drafts/:draftId", "required"),
  write("submitDraft", "POST", "/v1/agent-email/drafts/:draftId/submit", "none"),
  write(
    "approveDraft",
    "POST",
    "/v1/agent-email/drafts/:draftId/approve",
    "none",
    200,
    "agent-email:admin",
  ),
  write("cancelDraft", "POST", "/v1/agent-email/drafts/:draftId/cancel", "none"),
  write(
    "rejectDraft",
    "POST",
    "/v1/agent-email/drafts/:draftId/reject",
    "required",
    200,
    "agent-email:admin",
  ),
  write("sendDraft", "POST", "/v1/agent-email/drafts/:draftId/send", "none", 202),
  read("getUsage", "/v1/agent-email/usage"),
  readPost("exportUsage", "/v1/agent-email/usage/export", "optional"),
  read("getPolicy", "/v1/agent-email/policy"),
  write("updatePolicy", "PATCH", "/v1/agent-email/policy", "required", 200, "agent-email:admin"),
  write(
    "createSuppression",
    "POST",
    "/v1/agent-email/suppressions",
    "required",
    201,
    "agent-email:admin",
  ),
  read("listSuppressions", "/v1/agent-email/suppressions"),
  write(
    "removeSuppression",
    "POST",
    "/v1/agent-email/suppressions/:suppressionId/remove",
    "none",
    200,
    "agent-email:admin",
  ),
]) satisfies readonly AgentEmailApiRoute[];
