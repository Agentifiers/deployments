import {
  type CommandRunner,
  type Environment,
  log,
  repositoryRoot,
  singleLine,
} from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";

const healthAttempts = 9;
const healthRetryDelayMs = 5_000;

export function platformEndpoint(outputs: TerraformOutputs) {
  const endpoint = outputs.platform_api_endpoint;
  return typeof endpoint === "string" && endpoint ? endpoint : undefined;
}

/** Requires `/health` to report `status: "ok"`, retrying transient failures. */
export async function verifyHealth(
  endpoint: string,
  options: { readonly fetch?: typeof fetch; readonly retryDelayMs?: number } = {},
) {
  const request = options.fetch ?? fetch;
  let lastError = "no response";
  for (let attempt = 1; attempt <= healthAttempts; attempt += 1) {
    try {
      const response = await request(`${endpoint}/health`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (body !== null && typeof body === "object" && Reflect.get(body, "status") === "ok") {
        log(`health verified at ${endpoint}`);
        return;
      }
      throw new Error("status is not ok");
    } catch (error) {
      lastError = singleLine(error);
    }
    if (attempt < healthAttempts) await Bun.sleep(options.retryDelayMs ?? healthRetryDelayMs);
  }
  throw new Error(`Health check failed for ${endpoint}/health: ${lastError}`);
}

/** The deployed stream gateway origin, when the target enables it. */
export function streamGatewayEndpoint(outputs: TerraformOutputs) {
  const endpoint = outputs.stream_gateway_base_url;
  return typeof endpoint === "string" && endpoint ? endpoint : undefined;
}

/** The deployed console origin, when the target enables the console. */
export function consoleEndpoint(outputs: TerraformOutputs) {
  const endpoint = outputs.console_url;
  return typeof endpoint === "string" && endpoint ? endpoint : undefined;
}

/** Verifies the public endpoint and runs the public API/CLI end-to-end suite against it. */
export async function verifyPublicSurface(input: {
  readonly endpoint: string;
  readonly environment: Environment;
  readonly run: CommandRunner;
  readonly streamGatewayUrl: string | undefined;
}) {
  await verifyHealth(input.endpoint);
  log("running public end-to-end suite");
  await input.run(["bun", "run", "e2e:public"], {
    cwd: repositoryRoot,
    env: {
      ...input.environment,
      DEPLOYMENTS_E2E_API_URL: input.endpoint,
      ...(input.streamGatewayUrl
        ? { DEPLOYMENTS_E2E_STREAM_GATEWAY_URL: input.streamGatewayUrl }
        : {}),
    },
    stream: true,
  });
}
