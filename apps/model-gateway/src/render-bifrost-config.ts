import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBifrostConfigJson,
  generateBifrostInternalVirtualKey,
  MODEL_GATEWAY_PROVIDERS,
  type ModelGatewayProvider,
} from "@deployments-ai/model-gateway";

const BIFROST_RENDER_ENV = {
  bedrockRegion: "MODEL_GATEWAY_BEDROCK_REGION",
  hostedProviders: "MODEL_GATEWAY_HOSTED_PROVIDERS",
  openAiBaseUrl: "MODEL_GATEWAY_OPENAI_BASE_URL",
  runtimeDir: "MODEL_GATEWAY_BIFROST_RUNTIME_DIR",
} as const;

export const BIFROST_CONFIG_FILE = "config.json";
export const BIFROST_VIRTUAL_KEY_FILE = "bifrost-virtual-key";

function hostedProviders(value: string | undefined): ModelGatewayProvider[] {
  const providers = (value ?? "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  if (providers.length === 0) throw new Error(`${BIFROST_RENDER_ENV.hostedProviders} is required.`);
  const unsupported = providers.find(
    (provider) => !(MODEL_GATEWAY_PROVIDERS as readonly string[]).includes(provider),
  );
  if (unsupported !== undefined) {
    throw new Error(
      `${BIFROST_RENDER_ENV.hostedProviders} names unsupported provider ${unsupported}.`,
    );
  }
  return providers as ModelGatewayProvider[];
}

/** Writes a read-only file atomically: a temporary sibling is renamed over the target. */
async function writeReadOnlyFile(path: string, contents: string) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o444 });
    await chmod(temporary, 0o444);
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

/**
 * Renders Bifrost's `config.json` and a fresh internal virtual key into the task-local runtime
 * directory shared with the Bifrost and gateway containers. Runs once per task start.
 */
export async function renderBifrostRuntimeFiles(environment: NodeJS.ProcessEnv = process.env) {
  const runtimeDir = environment[BIFROST_RENDER_ENV.runtimeDir]?.trim();
  if (!runtimeDir) throw new Error(`${BIFROST_RENDER_ENV.runtimeDir} is required.`);
  const bedrockRegion = environment[BIFROST_RENDER_ENV.bedrockRegion]?.trim();
  const openAiBaseUrl = environment[BIFROST_RENDER_ENV.openAiBaseUrl]?.trim();
  const internalVirtualKey = generateBifrostInternalVirtualKey();
  const configJson = createBifrostConfigJson({
    ...(bedrockRegion ? { bedrockRegion } : {}),
    hostedProviders: hostedProviders(environment[BIFROST_RENDER_ENV.hostedProviders]),
    internalVirtualKey,
    ...(openAiBaseUrl ? { openAiBaseUrl } : {}),
  });
  await mkdir(runtimeDir, { mode: 0o755, recursive: true });
  await chmod(runtimeDir, 0o755);
  await writeReadOnlyFile(join(runtimeDir, BIFROST_VIRTUAL_KEY_FILE), internalVirtualKey);
  await writeReadOnlyFile(join(runtimeDir, BIFROST_CONFIG_FILE), configJson);
}

if (import.meta.main) {
  renderBifrostRuntimeFiles().then(
    () => console.log(JSON.stringify({ event: "bifrost_config.rendered", level: "info" })),
    (cause: unknown) => {
      console.error(
        JSON.stringify({
          event: "bifrost_config.render_failed",
          level: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
      process.exitCode = 1;
    },
  );
}
