import type { BrainUploadTicketResponse } from "@deployments-ai/api-contract/brains";
import {
  uploadBrainContent,
  type PlatformRequest,
  type PlatformSdk,
} from "@agentifiers/deployments-sdk";
import { CliError, ExitCode } from "./errors.ts";
import type { CommandCatalog } from "./types.ts";
import {
  action,
  json,
  number,
  positional,
  requiredCsv,
  requiredJson,
  requiredNumber,
  requiredText,
  text,
} from "./catalog-helpers.ts";

const brainId = { ...positional("Brain ID"), field: "brainId" } as const;
const sourceId = { ...positional("Brain source ID"), field: "sourceId" } as const;
const grantId = { ...positional("Brain grant ID"), field: "grantId" } as const;
const mountId = { ...positional("Brain mount ID"), field: "mountId" } as const;
const ticketId = { ...positional("Brain upload ticket ID"), field: "ticketId" } as const;
const documentId = { ...positional("Brain document ID"), field: "documentId" } as const;
const entityId = { ...positional("Brain entity ID"), field: "entityId" } as const;
const queryAttemptId = {
  ...positional("Brain query attempt ID"),
  field: "queryAttemptId",
} as const;
const erasureId = { ...positional("Brain erasure ID"), field: "erasureId" } as const;
const pagination = { limitField: "limit", maxLimit: 100, target: "query" as const };

/** Reads the ticket and stores the file through its direct upload, so files the API PUT refuses still upload. */
async function sendBrainUploadContent(sdk: PlatformSdk, request: PlatformRequest) {
  const ticket = await sdk.request<BrainUploadTicketResponse>({
    ...(request.context ? { context: request.context } : {}),
    method: "GET",
    path: request.path.slice(0, -"/content".length),
  });
  if (request.contentType !== ticket.data.mediaType) {
    throw new CliError(
      `--content-type must be the ticket's media type, ${ticket.data.mediaType}.`,
      ExitCode.validation,
    );
  }
  return uploadBrainContent(sdk, {
    bytes: request.rawBody!,
    context: request.context ?? {},
    idempotencyKey: request.idempotencyKey!,
    ticket: ticket.data,
  });
}

export const brainCommandCatalog: CommandCatalog = {
  brain: {
    summary: "Governed company and member-private knowledge Brains",
    actions: {
      search: action({
        summary: "Search source-grounded Brain evidence",
        method: "POST",
        path: "/v1/brains/search",
        scope: "tenant",
        output: "list",
        listField: "results",
        pagination: false,
        idempotent: true,
        args: {
          brains: { ...requiredCsv("Brain IDs"), bodyField: "brainIds" },
          limit: number("Maximum evidence results"),
          query: requiredText("Evidence query"),
        },
      }),
      ask: action({
        summary: "Ask a cited question across authorized Brains",
        method: "POST",
        path: "/v1/brains/ask",
        scope: "tenant",
        output: "detail",
        idempotent: true,
        args: {
          brains: { ...requiredCsv("Brain IDs"), bodyField: "brainIds" },
          "evidence-limit": number("Maximum evidence results"),
          question: requiredText("Question"),
        },
      }),
      list: action({
        summary: "List visible Brains",
        method: "GET",
        path: "/v1/brains",
        scope: "organization",
        output: "list",
        listField: "items",
        pagination,
        args: { status: text("Brain status", "query") },
      }),
      create: action({
        summary: "Create a Brain",
        method: "POST",
        path: "/v1/brains",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          kind: requiredText("Brain kind: company or member-private"),
          name: requiredText("Brain name"),
          sensitivity: text("Default sensitivity"),
          slug: requiredText("Organization-unique Brain slug"),
        },
      }),
      show: action({
        summary: "Show a Brain",
        method: "GET",
        path: "/v1/brains/:brainId",
        scope: "organization",
        output: "detail",
        args: { brain: brainId },
      }),
      "index-health": action({
        summary: "List Brain document index health",
        method: "GET",
        path: "/v1/brains/:brainId/index-health",
        scope: "organization",
        output: "list",
        listField: "items",
        pagination,
        args: { brain: brainId },
      }),
      update: action({
        summary: "Update a Brain",
        method: "PATCH",
        path: "/v1/brains/:brainId",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          brain: brainId,
          "expected-version": requiredNumber("Current Brain version"),
          "maintenance-policy": json("Maintenance policy"),
          name: text("Brain name"),
          "retrieval-policy": json("Retrieval policy"),
          sensitivity: text("Default sensitivity"),
          slug: text("Organization-unique Brain slug"),
        },
      }),
      archive: action({
        summary: "Archive a Brain",
        method: "DELETE",
        path: "/v1/brains/:brainId",
        scope: "organization",
        output: "action",
        idempotent: true,
        destructive: true,
        args: {
          brain: brainId,
          "expected-version": requiredNumber("Current Brain version"),
        },
      }),
    },
  },
  "brain-feedback": {
    summary: "Brain answer and retrieval usefulness feedback",
    actions: {
      create: action({
        summary: "Record usefulness feedback for a Brain query",
        method: "POST",
        path: "/v1/brains/query-attempts/:queryAttemptId/feedback",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          feedback: text("Optional feedback detail"),
          query: queryAttemptId,
          usefulness: requiredText("Usefulness: harmful, neutral, or useful"),
        },
      }),
    },
  },
  "brain-erasure": {
    summary: "Generation-fenced Brain erasure operations",
    actions: {
      create: action({
        summary: "Permanently erase a Brain and its derived data",
        method: "POST",
        path: "/v1/brains/:brainId/erasures",
        scope: "organization",
        output: "detail",
        idempotent: true,
        destructive: true,
        args: {
          brain: brainId,
          "expected-version": requiredNumber("Current Brain version"),
        },
      }),
      show: action({
        summary: "Show a Brain erasure receipt",
        method: "GET",
        path: "/v1/brains/:brainId/erasures/:erasureId",
        scope: "organization",
        output: "detail",
        args: { brain: brainId, erasure: erasureId },
      }),
    },
  },
  "brain-grant": {
    summary: "Human, service, and agent Brain grants",
    actions: {
      list: action({
        summary: "List Brain grants",
        method: "GET",
        path: "/v1/brains/:brainId/grants",
        scope: "organization",
        output: "list",
        listField: "items",
        pagination,
        args: { brain: brainId },
      }),
      create: action({
        summary: "Create a Brain grant",
        method: "POST",
        path: "/v1/brains/:brainId/grants",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          brain: brainId,
          permission: requiredText("Brain permission"),
          target: requiredJson("Grant target identity"),
        },
      }),
      revoke: action({
        summary: "Revoke a Brain grant",
        method: "DELETE",
        path: "/v1/brains/:brainId/grants/:grantId",
        scope: "organization",
        output: "action",
        idempotent: true,
        destructive: true,
        args: {
          brain: brainId,
          grant: grantId,
          "expected-version": requiredNumber("Current grant version"),
        },
      }),
    },
  },
  "brain-mount": {
    summary: "Deployment Brain mounts",
    actions: {
      list: action({
        summary: "List Brain mounts",
        method: "GET",
        path: "/v1/brains/:brainId/mounts",
        scope: "organization",
        output: "list",
        listField: "items",
        pagination,
        args: { brain: brainId },
      }),
      create: action({
        summary: "Mount a Brain on an agent deployment",
        method: "POST",
        path: "/v1/brains/:brainId/mounts",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          brain: brainId,
          "agent-definition-id": requiredText("Agent definition ID"),
          "agent-deployment-id": requiredText("Agent deployment ID"),
          "environment-id": requiredText("Environment ID"),
          permission: requiredText("Mount permission"),
          "project-id": requiredText("Project ID"),
        },
      }),
      revoke: action({
        summary: "Revoke a Brain mount",
        method: "DELETE",
        path: "/v1/brains/:brainId/mounts/:mountId",
        scope: "organization",
        output: "action",
        idempotent: true,
        destructive: true,
        args: {
          brain: brainId,
          mount: mountId,
          "expected-version": requiredNumber("Current mount version"),
        },
      }),
    },
  },
  "brain-source": {
    summary: "Brain knowledge sources",
    actions: {
      list: action({
        summary: "List Brain sources",
        method: "GET",
        path: "/v1/brains/:brainId/sources",
        scope: "organization",
        output: "list",
        listField: "items",
        pagination,
        args: { brain: brainId },
      }),
      create: action({
        summary: "Create a Brain source",
        method: "POST",
        path: "/v1/brains/:brainId/sources",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          brain: brainId,
          "connection-id": text("Provider connection ID"),
          kind: requiredText("Source kind"),
          name: requiredText("Source name"),
        },
      }),
    },
  },
  "brain-upload": {
    summary: "Controlled Brain content uploads",
    actions: {
      create: action({
        summary: "Issue a Brain upload ticket",
        method: "POST",
        path: "/v1/brains/:brainId/sources/:sourceId/uploads",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          brain: brainId,
          source: sourceId,
          "expected-byte-size": requiredNumber("Exact upload byte size"),
          "expected-content-hash": requiredText("sha256: content hash"),
          "media-type": requiredText("Content media type"),
        },
      }),
      show: action({
        summary: "Show a Brain upload ticket",
        method: "GET",
        path: "/v1/brains/:brainId/sources/:sourceId/uploads/:ticketId",
        scope: "organization",
        output: "detail",
        args: { brain: brainId, source: sourceId, ticket: ticketId },
      }),
      content: action({
        summary: "Upload exact Brain ticket content",
        method: "PUT",
        path: "/v1/brains/:brainId/sources/:sourceId/uploads/:ticketId/content",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          brain: brainId,
          source: sourceId,
          ticket: ticketId,
          file: requiredText("Upload file", "control"),
          "content-type": requiredText("Exact content media type", "control"),
        },
        rawFileInput: {
          argument: "file",
          contentTypeArgument: "content-type",
          maximumBytes: 8 * 1024 * 1024,
        },
        send: sendBrainUploadContent,
      }),
      complete: action({
        summary: "Complete a ticket whose content was stored through its direct upload",
        method: "POST",
        path: "/v1/brains/:brainId/sources/:sourceId/uploads/:ticketId/complete",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: { brain: brainId, source: sourceId, ticket: ticketId },
      }),
    },
  },
  "brain-document": {
    summary: "Immutable Brain document revisions",
    actions: {
      capture: action({
        summary: "Capture a Brain document revision",
        method: "POST",
        path: "/v1/brains/:brainId/sources/:sourceId/documents",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          brain: brainId,
          source: sourceId,
          "completed-upload-ticket-id": text("Completed upload ticket ID"),
          "external-item-identity": requiredText("Stable source item identity"),
          kind: requiredText("Revision kind"),
          "media-type": text("Content media type"),
          "restored-content-version-id": text("Retained content version ID"),
          sensitivity: text("Document sensitivity"),
          "source-locator": text("Canonical source locator"),
          "source-order": number("Monotonic source order"),
          "source-revision": text("Source revision"),
          "source-timestamp": text("Source timestamp"),
          "stable-version": text("Provider stable version or ETag"),
          title: text("Document title"),
          "transition-reason": text("Lifecycle transition reason"),
        },
      }),
      show: action({
        summary: "Show a Brain document and current immutable version",
        method: "GET",
        path: "/v1/brains/:brainId/documents/:documentId",
        scope: "organization",
        output: "detail",
        args: { brain: brainId, document: documentId },
      }),
    },
  },
  "brain-entity": {
    summary: "Canonical Brain entities and cited relationships",
    actions: {
      show: action({
        summary: "Show a Brain entity with bounded cited relationships",
        method: "GET",
        path: "/v1/brains/:brainId/entities/:entityId",
        scope: "organization",
        output: "detail",
        args: { brain: brainId, entity: entityId },
      }),
    },
  },
  "brain-review": {
    summary: "Brain curator review items",
    actions: {
      list: action({
        summary: "List open Brain review items",
        method: "GET",
        path: "/v1/brains/:brainId/review-items",
        scope: "organization",
        output: "list",
        listField: "items",
        pagination,
        args: { brain: brainId },
      }),
      resolve: action({
        summary: "Resolve a Brain review item",
        method: "POST",
        path: "/v1/brains/:brainId/review-items/:reviewItemId/resolve",
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          brain: brainId,
          decision: requiredText("Review decision"),
          "expected-version": requiredNumber("Current review version"),
          review: { ...positional("Brain review item ID"), field: "reviewItemId" },
          "target-entity-id": text("Required canonical entity target for merge decisions"),
        },
      }),
    },
  },
};
