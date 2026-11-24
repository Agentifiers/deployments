import { objectSchema, stringProperty } from "../tool-definition-builders.ts";
import { deferredBusinessRead } from "./common.ts";

const HOSTS = ["api.audiencetap.com"] as const;

export const audiencetapNativeHttpToolDefinitions = [
  deferredBusinessRead({
    auditSelectorKeys: ["accountId"],
    description:
      "Deferred AudienceTap audience read; the repository does not pin a current endpoint.",
    expectedHost: "api.audiencetap.com",
    hosts: HOSTS,
    inputSchema: objectSchema(
      { accountId: stringProperty("Authorized AudienceTap account selector.") },
      ["accountId"],
    ),
    provider: "audiencetap",
    resourceTypes: ["account"],
    sampleInput: { accountId: "account_1" },
    toolName: "audiencetap.audiences.list",
    deferredReason:
      "the routing catalog records a bearer API-key route but vendored sources omit the current audience collection path",
  }),
  deferredBusinessRead({
    auditSelectorKeys: ["accountId"],
    description:
      "Deferred AudienceTap campaign read; the repository does not pin a current endpoint.",
    expectedHost: "api.audiencetap.com",
    hosts: HOSTS,
    inputSchema: objectSchema(
      { accountId: stringProperty("Authorized AudienceTap account selector.") },
      ["accountId"],
    ),
    provider: "audiencetap",
    resourceTypes: ["account"],
    sampleInput: { accountId: "account_1" },
    toolName: "audiencetap.campaigns.list",
    deferredReason:
      "the routing catalog records a bearer API-key route but vendored sources omit the current campaign collection path",
  }),
] as const;
