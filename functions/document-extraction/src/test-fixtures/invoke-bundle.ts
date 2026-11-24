import { join } from "node:path";

export interface BundleInvocation {
  readonly result: unknown;
  readonly logs: readonly { readonly message: unknown; readonly fields: unknown }[];
}

const HARNESS =
  "const logs = [];" +
  "console.info = (message, fields) => logs.push({ message, fields });" +
  "const { handler } = await import(new URL(`file://${process.argv[1]}`));" +
  "let result;" +
  "try { result = await handler(JSON.parse(process.argv[2])); }" +
  "catch (error) { result = { thrown: error.message }; }" +
  "process.stdout.write(JSON.stringify({ result, logs }), () => process.exit(0));";

export async function invokeBundle(input: {
  readonly node: string;
  readonly bundle: string;
  readonly event: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<BundleInvocation> {
  const child = Bun.spawn(
    [
      input.node,
      "--input-type=module",
      "-e",
      HARNESS,
      join(input.bundle, "handler.mjs"),
      JSON.stringify(input.event),
    ],
    { env: input.env, stderr: "ignore", stdout: "pipe" },
  );
  const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return JSON.parse(output);
}
