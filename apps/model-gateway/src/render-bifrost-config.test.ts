import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIFROST_INTERNAL_VIRTUAL_KEY_ID } from "@deployments-ai/model-gateway";
import {
  BIFROST_CONFIG_FILE,
  BIFROST_VIRTUAL_KEY_FILE,
  renderBifrostRuntimeFiles,
} from "./render-bifrost-config.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function runtimeDir() {
  const parent = await mkdtemp(join(tmpdir(), "model-gateway-render-"));
  directories.push(parent);
  return join(parent, "run", "model-gateway");
}

describe("renderBifrostRuntimeFiles", () => {
  test("writes config.json and a fresh internal key, read-only, in a 0755 directory", async () => {
    const dir = await runtimeDir();
    await renderBifrostRuntimeFiles({
      MODEL_GATEWAY_BEDROCK_REGION: "us-east-2",
      MODEL_GATEWAY_BIFROST_RUNTIME_DIR: dir,
      MODEL_GATEWAY_HOSTED_PROVIDERS: "bedrock, openai",
    });

    expect((await readdir(dir)).sort()).toEqual(
      [BIFROST_VIRTUAL_KEY_FILE, BIFROST_CONFIG_FILE].sort(),
    );
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    for (const file of [BIFROST_CONFIG_FILE, BIFROST_VIRTUAL_KEY_FILE]) {
      expect((await stat(join(dir, file))).mode & 0o777).toBe(0o444);
    }
    const key = await readFile(join(dir, BIFROST_VIRTUAL_KEY_FILE), "utf8");
    expect(key).toMatch(/^sk-bf-[A-Za-z0-9_-]{43,}$/u);
    const config = await readFile(join(dir, BIFROST_CONFIG_FILE), "utf8");
    expect(config).toContain(key);
    expect(config).toContain(BIFROST_INTERNAL_VIRTUAL_KEY_ID);
    expect(JSON.parse(config)).toMatchObject({ providers: { bedrock: {}, openai: {} } });
  });

  test("generates a different key on every render, replacing the files atomically", async () => {
    const dir = await runtimeDir();
    const environment = {
      MODEL_GATEWAY_BIFROST_RUNTIME_DIR: dir,
      MODEL_GATEWAY_HOSTED_PROVIDERS: "openrouter",
    };
    await renderBifrostRuntimeFiles(environment);
    const first = await readFile(join(dir, BIFROST_VIRTUAL_KEY_FILE), "utf8");
    await renderBifrostRuntimeFiles(environment);
    expect(await readFile(join(dir, BIFROST_VIRTUAL_KEY_FILE), "utf8")).not.toBe(first);
    expect(await readdir(dir)).toHaveLength(2);
  });

  test("routes the openai provider to MODEL_GATEWAY_OPENAI_BASE_URL", async () => {
    const dir = await runtimeDir();
    await renderBifrostRuntimeFiles({
      MODEL_GATEWAY_BIFROST_RUNTIME_DIR: dir,
      MODEL_GATEWAY_HOSTED_PROVIDERS: "openai,openrouter",
      MODEL_GATEWAY_OPENAI_BASE_URL: "http://10.42.32.17:8317",
    });
    const config = JSON.parse(await readFile(join(dir, BIFROST_CONFIG_FILE), "utf8"));
    expect(config.providers.openai.network_config).toEqual({
      allow_private_network: true,
      base_url: "http://10.42.32.17:8317",
    });
  });

  test("rejects missing or unsupported configuration without writing", async () => {
    const dir = await runtimeDir();
    for (const environment of [
      { MODEL_GATEWAY_HOSTED_PROVIDERS: "openai" },
      { MODEL_GATEWAY_BIFROST_RUNTIME_DIR: dir },
      { MODEL_GATEWAY_BIFROST_RUNTIME_DIR: dir, MODEL_GATEWAY_HOSTED_PROVIDERS: "anthropic" },
      { MODEL_GATEWAY_BIFROST_RUNTIME_DIR: dir, MODEL_GATEWAY_HOSTED_PROVIDERS: "bedrock" },
      {
        MODEL_GATEWAY_BIFROST_RUNTIME_DIR: dir,
        MODEL_GATEWAY_HOSTED_PROVIDERS: "openai",
        MODEL_GATEWAY_OPENAI_BASE_URL: "http://10.42.32.17:8317/v1",
      },
    ]) {
      expect(renderBifrostRuntimeFiles(environment)).rejects.toThrow();
    }
    expect(stat(dir)).rejects.toThrow();
  });
});
