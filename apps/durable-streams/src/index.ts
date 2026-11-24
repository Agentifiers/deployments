import { AuthenticatedDurableStreamsServer } from "./authenticated-server.ts";
import { durableStreamsRuntimeConfig } from "./config.ts";

const config = durableStreamsRuntimeConfig();
const server = new AuthenticatedDurableStreamsServer(config);
let isStopping = false;
let resolveShutdown!: () => void;
const shutdown = new Promise<void>((resolve) => {
  resolveShutdown = resolve;
});

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (isStopping) return;
  isStopping = true;
  process.stdout.write(`\n${signal} received; stopping Durable Streams server.\n`);
  try {
    await server.stop();
    process.exitCode = 0;
  } catch (cause) {
    process.exitCode = 1;
    process.stderr.write(
      cause instanceof Error ? `${cause.stack ?? cause.message}\n` : `${String(cause)}\n`,
    );
  } finally {
    resolveShutdown();
  }
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

const url = await server.start();
process.stdout.write(`Durable Streams server listening at ${url} with dataDir ${config.dataDir}\n`);

await shutdown;
