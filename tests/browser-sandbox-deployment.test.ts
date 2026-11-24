import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stackAgentRuntime = readFileSync("infrastructure/modules/platform/agent-runtime.tf", "utf8");
const agentWorker = readFileSync("infrastructure/modules/agent-runtime/worker-service.tf", "utf8");
const platformData = readFileSync("infrastructure/modules/platform-data/main.tf", "utf8");
const sandboxRuntime = readFileSync("infrastructure/modules/sandbox-runtime/main.tf", "utf8");

describe("browser and sandbox deployment", () => {
  test("passes browser origins to the agent worker that runs browser tools in sandboxes", () => {
    expect(stackAgentRuntime).toContain(
      'DEPLOYMENTS_AI_BROWSER_SCREENSHOT_ALLOWED_ORIGINS = join(",", var.agent_runtime_browser_allowed_origins)',
    );
    expect(stackAgentRuntime).toContain(
      'var.agent_runtime_browser_any_public_origin ? { DEPLOYMENTS_AI_BROWSER_ANY_PUBLIC_ORIGIN = "true" } : {}',
    );
  });

  test("lets the agent worker store 30-day browser session replays", () => {
    expect(agentWorker).toMatch(
      /sid\s+= "BrowserSessionIdempotency"\s+actions\s+= \["s3:GetObject", "s3:PutObject"\]\s+resources = \["\$\{var\.artifact_bucket_arn\}\/browser-session-idempotency\/\*"\]/u,
    );
    expect(platformData).toMatch(
      /id\s+= "expire-browser-session-idempotency"[\s\S]+prefix = "browser-session-idempotency\/"[\s\S]+expiration \{\s+days = 30[\s\S]+noncurrent_version_expiration \{\s+noncurrent_days = 1/u,
    );
  });

  test("lets Lambda MicroVMs assume the sandbox runtime roles", () => {
    expect(sandboxRuntime).toContain('"lambda-microvms.amazonaws.com"');
  });
});
