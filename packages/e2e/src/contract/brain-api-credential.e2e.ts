import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { E2eHttpClientService, HttpRequest } from "../harness/http-client.ts";
import type { ScopedE2eConfig } from "../harness/live-config.ts";
import { makeBrainApi } from "../live/brain-lifecycle-support.ts";

it.effect("re-reads the refreshed platform token each time a built Brain request runs", () =>
  Effect.gen(function* () {
    let token = "token-1";
    const config = {
      apiUrl: "https://api.example",
      environmentId: "env",
      organizationId: "org",
      platformCredential: {
        get token() {
          return token;
        },
      },
      projectId: "project",
    } as ScopedE2eConfig;
    const sent: HttpRequest[] = [];
    const http: E2eHttpClientService = {
      request: (request) =>
        Effect.sync(() => {
          sent.push(request);
          return { body: "{}", headers: {}, json: {}, status: 200 };
        }),
    };
    const poll = makeBrainApi(config, http).request({
      method: "GET",
      path: "/v1/brains/brain/erasures/erasure",
    });

    yield* poll;
    token = "token-2";
    yield* poll;

    expect(sent.map((request) => request.headers?.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
  }),
);
