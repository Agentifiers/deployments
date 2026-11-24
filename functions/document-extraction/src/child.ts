import {
  decodeChildInput,
  encodeChildOutput,
  SANDBOX_UNAVAILABLE_EXIT_CODE,
} from "./child-protocol.ts";
import { extractDocument } from "./engine/registry.ts";

function sandboxIsInForce() {
  const permission: NodeJS.ProcessPermission | undefined = process.permission;
  if (
    permission === undefined ||
    permission.has("fs.write") ||
    permission.has("child") ||
    permission.has("worker") ||
    permission.has("fs.read", "/etc/hosts")
  ) {
    return false;
  }
  return process.execArgv.includes("--disallow-code-generation-from-strings");
}

if (!sandboxIsInForce()) process.exit(SANDBOX_UNAVAILABLE_EXIT_CODE);
const stdin: Buffer[] = [];
for await (const chunk of process.stdin) stdin.push(Buffer.from(chunk));
const { hint, bytes, scans } = decodeChildInput(Buffer.concat(stdin));
process.stdout.write(encodeChildOutput(await extractDocument(bytes, hint, scans)), () =>
  process.exit(0),
);
