import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync("infrastructure/modules/brain-runtime/sync.tf", "utf8");

function resourceBlock(header: string) {
  const start = source.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("\n}\n", start));
}

describe("Brain sync dispatch rule", () => {
  test("routes only source-created events that announce a sync job to the dispatcher", () => {
    // Upload and other unmanaged sources commit no sync job, so their events omit its identity;
    // the dispatcher requires it and must never be invoked for them.
    const rule = resourceBlock('resource "aws_cloudwatch_event_rule" "sync_created" {');
    expect(rule).toContain('"detail-type" = ["brain-source.created"]');
    expect(rule).toMatch(
      /detail = \{\s*payload = \{\s*syncJobIdempotencyKey = \[\{ exists = true \}\]\s*\}\s*\}/u,
    );
  });
});
