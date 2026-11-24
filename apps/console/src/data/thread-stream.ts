import { createServerFn } from "@tanstack/react-start";
import { openThreadStream } from "../server/runtime-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { scopedInput, type ScopedInput } from "./server-input.ts";

/**
 * Mints a stream token for the browser to read the thread's stream with. Every call mints a new
 * token, so this is no query: invalidation and hover preloading must not call it.
 */
export const openThreadStreamFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly threadId: string }) =>
    scopedInput(input, ["threadId"]),
  )
  .handler(async ({ data }) =>
    openThreadStream(await requireAccessToken(), data.scope, data.threadId),
  );
