import type { Ulid } from "@deployments-ai/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLambdaMicrovmProvider, SandboxNetworkIsolationUnavailableError } from "./index.ts";

/**
 * Drives the real MicroVM guest control server (`apps/sandbox-microvm/control_server.py`) through
 * the Lambda MicroVM provider, so the provider's routes and the server's routes cannot drift.
 */

const PYTHON = Bun.which("python3");
const CONTROL_SERVER = join(import.meta.dir, "../../../apps/sandbox-microvm/control_server.py");
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FC0" as Ulid;

const lease = {
  environmentId: ID,
  executionTargetId: ID,
  executionTargetKind: "agent-deployment" as const,
  externalSandboxId: "microvm_control_server",
  isolationMode: "run-ephemeral" as const,
  organizationId: ID,
  projectId: ID,
  provider: "aws_lambda_microvm" as const,
  runId: ID,
  status: "ready" as const,
};

let workspace = "";
let port = 0;
let server: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;

function freePort() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port: chosen } = listener;
  listener.stop(true);
  return chosen;
}

/**
 * The control server speaks HTTP/1.0 and closes after every response. Bun's pooled sockets race
 * that close on Linux (ECONNRESET), so requests to the local server never reuse a socket.
 */
function localFetch(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, keepalive: false });
}

/** Resolves once the server announces it is listening; keeps draining its request log after. */
function listening(stdout: ReadableStream<Uint8Array>) {
  const { promise, reject, resolve } = Promise.withResolvers<void>();
  void (async () => {
    const decoder = new TextDecoder();
    let seen = "";
    for await (const chunk of stdout) {
      seen += decoder.decode(chunk, { stream: true });
      if (seen.includes("listening on")) resolve();
    }
    reject(new Error(`The control server exited before listening:\n${seen}`));
  })();
  return promise;
}

function provider() {
  return createLambdaMicrovmProvider({
    client: {
      async send(command) {
        const name = command.constructor.name;
        if (name === "GetMicrovmCommand") return { endpoint: "microvm-local.lambda-microvms.aws" };
        if (name === "CreateMicrovmAuthTokenCommand") {
          return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
        }
        throw new Error(`Unexpected command ${name}`);
      },
    },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return localFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
    },
    imageIdentifier: "lambda-image",
  });
}

/** Records that the command ran, then prints the interfaces of its own network namespace. */
function probe(marker: string) {
  return [
    PYTHON!,
    "-c",
    [
      "import pathlib",
      `pathlib.Path(${JSON.stringify(marker)}).write_text("ran")`,
      "lines = pathlib.Path('/proc/self/net/dev').read_text().splitlines()[2:]",
      "print(' '.join(sorted(line.split(':', 1)[0].strip() for line in lines)))",
    ].join("\n"),
  ];
}

describe.skipIf(!PYTHON)("Lambda MicroVM guest control server", () => {
  beforeAll(async () => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "control-server-")));
    port = freePort();
    server = Bun.spawn([PYTHON!, CONTROL_SERVER], {
      env: {
        PATH: process.env.PATH ?? "",
        PYTHONUNBUFFERED: "1",
        SANDBOX_CONTROL_HOST: "127.0.0.1",
        SANDBOX_CONTROL_PORT: String(port),
        SANDBOX_WORKSPACE: workspace,
      },
      stderr: "ignore",
      stdin: "ignore",
      stdout: "pipe",
    });
    await listening(server.stdout);
  });

  afterAll(async () => {
    server?.kill();
    await server?.exited;
    rmSync(workspace, { force: true, recursive: true });
  });

  test("runs an ordinary exec on the exec route", async () => {
    const result = await provider().exec({ command: ["pwd"], lease });

    expect(result).toMatchObject({ exitCode: 0, stdout: `${workspace}\n` });
  });

  test("runs an isolated exec in an empty network namespace, or refuses it without running", async () => {
    const marker = join(workspace, "isolated-ran");

    const outcome = await provider()
      .exec({ command: probe(marker), lease, network: "none" })
      .catch((cause: unknown) => cause);

    // Host support for owned network namespaces varies (Lambda MicroVM guests allow it; macOS and
    // AppArmor-restricted Linux hosts refuse it), so assert the fail-closed invariant for both
    // outcomes: either the command ran and saw only loopback, or it was refused and never ran.
    if (outcome instanceof Error) {
      expect(outcome).toBeInstanceOf(SandboxNetworkIsolationUnavailableError);
      expect(existsSync(marker)).toBe(false);
    } else {
      expect(outcome).toMatchObject({ exitCode: 0, stdout: "lo\n" });
      expect(existsSync(marker)).toBe(true);
    }
  });

  test("refuses a network field on the plain exec route without running the command", async () => {
    const marker = join(workspace, "legacy-field-ran");

    const response = await localFetch(`http://127.0.0.1:${port}/__sandbox/exec`, {
      body: JSON.stringify({ command: probe(marker), network: "none" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(existsSync(marker)).toBe(false);
  });

  test("refuses browser-originated requests without running them", async () => {
    const marker = join(workspace, "browser-ran");
    for (const headers of [
      { origin: "http://127.0.0.1:4173", "content-type": "text/plain" },
      { "content-type": "text/plain", "sec-fetch-site": "cross-site" },
    ]) {
      const response = await localFetch(`http://127.0.0.1:${port}/__sandbox/exec`, {
        body: JSON.stringify({ command: probe(marker) }),
        headers,
        method: "POST",
      });
      expect(response.status).toBe(403);
    }
    const read = await localFetch(`http://127.0.0.1:${port}/__sandbox/files?path=${workspace}`, {
      headers: { "sec-fetch-site": "same-site" },
    });
    expect(read.status).toBe(403);
    expect(existsSync(marker)).toBe(false);
  });
});

const VALIDATE_HOOK = "/aws/lambda-microvms/runtime/v1/validate";

/**
 * Starts a control server whose `node` is a stub: it records its arguments, waits until the test
 * calls `release`, then runs `stubExit`.
 */
async function validationServer(stubExit: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "control-server-validate-")));
  const argvFile = join(directory, "node-argv");
  const releaseFile = join(directory, "release");
  const stub = join(directory, "node");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `echo "$@" > ${JSON.stringify(argvFile)}`,
      `while [ ! -e ${JSON.stringify(releaseFile)} ]; do sleep 0.02; done`,
      stubExit,
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  const validationPort = freePort();
  const server = Bun.spawn([PYTHON!, CONTROL_SERVER], {
    env: {
      PATH: `${directory}:${Bun.env.PATH ?? ""}`,
      PYTHONUNBUFFERED: "1",
      SANDBOX_CONTROL_HOST: "127.0.0.1",
      SANDBOX_CONTROL_PORT: String(validationPort),
      SANDBOX_WORKSPACE: directory,
    },
    stderr: "ignore",
    stdin: "ignore",
    stdout: "pipe",
  });
  await listening(server.stdout);
  const validate = async () =>
    (await localFetch(`http://127.0.0.1:${validationPort}${VALIDATE_HOOK}`, { method: "POST" }))
      .status;
  return {
    argv: () => readFileSync(argvFile, "utf8").trim(),
    release: () => writeFileSync(releaseFile, ""),
    stop: async () => {
      server.kill();
      await server.exited;
      rmSync(directory, { force: true, recursive: true });
    },
    validate,
    /** Polls like Lambda does; the warm-up is another process, so there is no clock to fake. */
    validateUntilSettled: async () => {
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const status = await validate();
        if (status !== 503) return status;
        await Bun.sleep(20);
      }
      return 503;
    },
  };
}

describe.skipIf(!PYTHON)("Lambda MicroVM image validation hook", () => {
  test("holds validation with 503 while the browser warm-up runs, then passes it", async () => {
    const server = await validationServer("exit 0");
    try {
      expect(await server.validate()).toBe(503);
      server.release();

      expect(await server.validateUntilSettled()).toBe(200);
      expect(server.argv()).toBe("/opt/agent-sandbox/browser/driver.ts warm");
    } finally {
      await server.stop();
    }
  });

  test("fails validation when the browser warm-up fails", async () => {
    const server = await validationServer("exit 3");
    try {
      server.release();

      expect(await server.validateUntilSettled()).toBe(500);
    } finally {
      await server.stop();
    }
  });
});
