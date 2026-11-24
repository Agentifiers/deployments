import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { eventually } from "../harness/eventually.ts";

it.effect(
  "continues polling against real time under the Effect test runtime",
  () => {
    let attempts = 0;
    return eventually(
      { intervalMs: 10, label: "real-time poll", timeoutMs: 200 },
      Effect.sync(() => {
        attempts += 1;
        return attempts === 2 ? attempts : undefined;
      }),
    ).pipe(
      Effect.map((result) => {
        expect(result).toBe(2);
        expect(attempts).toBe(2);
      }),
    );
  },
  500,
);
