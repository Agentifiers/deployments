import type { PlatformRequest, PlatformSdk, PlatformStreamPage } from "./index.ts";
import type { RuntimeSdk, RuntimeStreamTarget } from "./runtime-sdk-client.ts";

type ThreadStreamReads = Pick<RuntimeSdk["threads"], "readStreamPage" | "streamEvents">;

function streamRequest(
  session: RuntimeStreamTarget,
  query: NonNullable<PlatformRequest["query"]>,
  signal: AbortSignal | undefined,
): PlatformRequest {
  const url = new URL(session.streamUrl);
  return {
    bearerToken: session.accessToken,
    method: "GET",
    origin: url.origin,
    path: url.pathname,
    query,
    ...(signal ? { signal } : {}),
  };
}

/** Thread stream reads, served by the stream gateway at the session's `streamUrl`. */
export function createThreadStreamReads(sdk: PlatformSdk): ThreadStreamReads {
  return {
    readStreamPage: (session, options = {}) =>
      sdk.streamPage(
        streamRequest(
          session,
          { cursor: options.cursor, live: options.live, offset: options.offset },
          options.signal,
        ),
      ),
    async *streamEvents<T>(
      session: RuntimeStreamTarget,
      options: Parameters<ThreadStreamReads["streamEvents"]>[1],
    ): AsyncIterable<PlatformStreamPage<T>> {
      let cursor = options.cursor;
      let offset = options.offset;
      while (!options.signal?.aborted) {
        try {
          for await (const page of sdk.streamBatches<T>(
            streamRequest(session, { cursor, live: "sse", offset }, options.signal),
          )) {
            if (page.cursor) cursor = page.cursor;
            if (page.nextOffset) offset = page.nextOffset;
            yield page;
            if (page.closed) return;
          }
        } catch (error) {
          if (options.signal?.aborted) return;
          throw error;
        }
      }
    },
  };
}
