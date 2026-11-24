import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { streamGatewayConfiguration } from "./config.ts";
import { createStreamGateway } from "./gateway.ts";

/**
 * Bun closes sockets idle longer than this; live reads stay open without bytes for at most the
 * Durable Streams long-poll/SSE window, which is well below Bun's 255 s ceiling.
 */
const SOCKET_IDLE_TIMEOUT_SECONDS = 255;

export async function startStreamGateway(environment: NodeJS.ProcessEnv = process.env) {
  const configuration = streamGatewayConfiguration(environment);
  const [durableAuthToken, sessionTokenSecret] = await Promise.all([
    loadAwsSecretString(configuration.durableAuthSecretArn),
    loadAwsSecretString(configuration.sessionSecretArn),
  ]);
  const shutdown = new AbortController();
  const server = Bun.serve({
    fetch: createStreamGateway({
      allowedOrigins: configuration.allowedOrigins,
      durableAuthToken,
      durableBaseUrl: configuration.durableBaseUrl,
      sessionTokenSecret,
      shutdownSignal: shutdown.signal,
    }),
    hostname: "0.0.0.0",
    idleTimeout: SOCKET_IDLE_TIMEOUT_SECONDS,
    port: configuration.port,
  });
  // ECS deregisters the task from the load balancer when it stops it (deploys, scale-in, Fargate
  // Spot interruptions); any reads still open are live tails that clients resume from their last
  // offset, so close them instead of waiting them out.
  const stop = () => {
    shutdown.abort();
    void server.stop(true);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.info("Stream gateway listening.", { port: server.port });
  return { server, stop };
}

if (import.meta.main) {
  startStreamGateway().catch((cause: unknown) => {
    console.error("Stream gateway failed to start.", cause);
    process.exitCode = 1;
  });
}
