/**
 * Guest-side runners for hosted code tools. Each runner is staged beside the pinned artifact
 * (`tool.mjs` / `tool.py`) and `input.json`, loads the customer module, deletes the staging
 * directory so no customer source lingers in a reused thread sandbox, calls the declared
 * entrypoint with the validated input, and writes exactly one JSON envelope to stdout:
 * `{"ok":true,"output":...}` or `{"ok":false,"error":{"name","message"}}`. Everything the tool
 * itself prints goes to stderr. A thrown error exits 1 so the worker reports a completed result
 * with a non-zero exit code.
 */

export const HOSTED_CODE_NODE_RUNNER = `import { readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const writeStderr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, encoding, callback) => writeStderr(chunk, encoding, callback);

function finish(envelope, code) {
  writeSync(1, JSON.stringify(envelope));
  process.exit(code);
}

try {
  const spec = JSON.parse(readFileSync(join(directory, "input.json"), "utf8"));
  // The customer module path is only known inside the staged sandbox directory.
  const loaded = await import(pathToFileURL(join(directory, "tool.mjs")).href);
  rmSync(directory, { force: true, recursive: true });
  const handler = loaded[spec.entrypoint];
  if (typeof handler !== "function") {
    throw new TypeError("Entrypoint " + spec.entrypoint + " is not an exported function.");
  }
  const output = await handler(spec.input);
  finish({ ok: true, output: output === undefined ? null : output }, 0);
} catch (error) {
  rmSync(directory, { force: true, recursive: true });
  if (error && error.stack) writeStderr(String(error.stack) + "\\n");
  finish(
    {
      error: {
        message: String(error && error.message !== undefined ? error.message : error),
        name: String((error && error.name) || "Error"),
      },
      ok: false,
    },
    1,
  );
}
`;

export const HOSTED_CODE_PYTHON_RUNNER = `import asyncio
import importlib.util
import inspect
import json
import os
import resource
import shutil
import sys
import traceback

directory = os.path.dirname(os.path.abspath(__file__))
result_fd = os.dup(1)
os.dup2(2, 1)
sys.stdout = sys.stderr


def finish(envelope, code):
    # Raw UTF-8, not \\uXXXX escapes, so the worker's secret redaction sees non-ASCII values as
    # the handler returned them. Lone surrogates (not UTF-8 encodable) become their JSON escape.
    encoded = json.dumps(
        envelope, allow_nan=False, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8", "backslashreplace")
    sys.stderr.flush()
    os.write(result_fd, encoded)
    os._exit(code)


async def settle(value):
    return await value


try:
    with open(os.path.join(directory, "input.json"), encoding="utf-8") as handle:
        spec = json.load(handle)
    limit = int(spec["memoryMiB"]) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    module_spec = importlib.util.spec_from_file_location(
        "hosted_tool", os.path.join(directory, "tool.py")
    )
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    shutil.rmtree(directory, ignore_errors=True)
    handler = getattr(module, spec["entrypoint"], None)
    if not callable(handler):
        raise TypeError("Entrypoint " + spec["entrypoint"] + " is not a function.")
    output = handler(spec["input"])
    if inspect.isawaitable(output):
        output = asyncio.run(settle(output))
    finish({"ok": True, "output": output}, 0)
except BaseException as error:
    shutil.rmtree(directory, ignore_errors=True)
    traceback.print_exc()
    finish({"ok": False, "error": {"name": type(error).__name__, "message": str(error)}}, 1)
`;
