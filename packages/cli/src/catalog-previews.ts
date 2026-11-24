import { action, id, json, number, requiredText, text } from "./catalog-helpers.ts";
import type { CommandCatalog } from "./types.ts";

const previewId = { ...id, field: "previewId" };

export const previewCommandCatalog: CommandCatalog = {
  preview: {
    summary: "Unpublished agent manifest previews",
    actions: {
      create: action({
        summary: "Create a preview from an unpublished agent manifest",
        method: "POST",
        path: "/v1/previews",
        scope: "environment",
        output: "detail",
        args: {
          manifest: json("Agent manifest JSON"),
          "manifest-file": text("Local agent manifest JSON file", "control"),
          "runtime-config": json("Preview runtime configuration JSON"),
          "runtime-config-file": text("Local runtime configuration JSON file", "control"),
          "from-agent-deployment-id": text("Agent deployment whose runtime configuration to reuse"),
          "ttl-seconds": number("Preview lifetime in seconds (60-604800)"),
        },
        fileInputs: [
          {
            argument: "manifest-file",
            bodyField: "manifest",
            format: "json",
            exclusiveWith: "manifest",
            required: true,
          },
          {
            argument: "runtime-config-file",
            bodyField: "runtimeConfig",
            format: "json",
            exclusiveWith: "runtime-config",
            required: false,
          },
        ],
        idempotent: true,
      }),
      show: action({
        summary: "Show a preview",
        method: "GET",
        path: "/v1/previews/:previewId",
        scope: "environment",
        output: "detail",
        args: { id: previewId },
      }),
      delete: action({
        summary: "Expire a preview",
        method: "DELETE",
        path: "/v1/previews/:previewId",
        scope: "environment",
        output: "detail",
        args: { id: previewId },
        destructive: true,
      }),
      turn: action({
        summary: "Submit a turn to a preview",
        method: "POST",
        path: "/v1/previews/:previewId/turns",
        scope: "environment",
        output: "detail",
        args: {
          id: previewId,
          thread: { ...text("Thread ID"), bodyField: "threadId" },
          message: { ...requiredText("Message input"), bodyField: "content" },
        },
        idempotent: true,
      }),
    },
  },
};
