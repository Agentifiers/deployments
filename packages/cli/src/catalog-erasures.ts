import type { CommandCatalog } from "./types.ts";
import { action, id, requiredText, text } from "./catalog-helpers.ts";

export const threadErasureActions = {
  erase: action({
    summary: "Permanently erase a thread and everything derived from it",
    method: "POST",
    path: "/v1/threads/:threadId/erasures",
    scope: "environment",
    output: "detail",
    args: {
      id: { ...id, field: "threadId" },
    },
    destructive: true,
  }),
  "erasure-status": action({
    summary: "Show a thread erasure",
    method: "GET",
    path: "/v1/threads/:threadId/erasures/:erasureId",
    scope: "environment",
    output: "detail",
    args: {
      id: { ...id, field: "erasureId" },
      thread: { ...requiredText("Thread ID", "path"), field: "threadId" },
    },
  }),
};

export const erasureCommandCatalog: CommandCatalog = {
  "end-user": {
    summary: "Erase every conversation one of your end users owns",
    actions: {
      erase: action({
        summary: "Permanently erase every thread of one end user in the environment",
        method: "POST",
        path: "/v1/end-users/erasures",
        scope: "environment",
        output: "detail",
        args: {
          "end-user-id": { ...text("Your ID for the end user"), bodyField: "endUserId" },
          email: {
            ...text("Email address of a correspondent, instead of --end-user-id"),
            bodyField: "endUserId",
            transform: "email-end-user-id",
          },
        },
        destructive: true,
      }),
      "erasure-status": action({
        summary: "Show an end-user erasure",
        method: "GET",
        path: "/v1/end-users/erasures/:erasureId",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "erasureId" },
        },
      }),
    },
  },
};
