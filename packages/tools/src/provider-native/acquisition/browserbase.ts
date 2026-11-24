import { objectSchema, staticProviderUrl, stringProperty } from "../tool-definition-builders.ts";
import { acquisitionRead, id } from "./common.ts";

const HOSTS = ["api.browserbase.com"] as const;

export const browserbaseNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: (input) =>
      staticProviderUrl("api.browserbase.com", ["v1", "sessions", id(input, "sessionId"), "logs"]),
    description: "Read logs for a Browserbase session that was explicitly selected.",
    hosts: HOSTS,
    inputSchema: objectSchema({ sessionId: stringProperty("Browserbase session identifier.") }, [
      "sessionId",
    ]),
    provider: "browserbase",
    requiredScopes: ["session_logs:read"],
    resourceTypes: ["account"],
    sampleInput: { sessionId: "session_1" },
    toolName: "browserbase.session.logs.read",
  }),
] as const;
