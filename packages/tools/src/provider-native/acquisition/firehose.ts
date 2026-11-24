import { objectSchema, staticProviderUrl, stringProperty } from "../tool-definition-builders.ts";
import { acquisitionRead, acquisitionWrite, booleanProperty, bodyFromFields } from "./common.ts";

const HOSTS = ["api.firehose.com"] as const;
const FIREHOSE_RULE_READ_SCOPES = ["rules:read"] as const;
const FIREHOSE_RULE_WRITE_SCOPES = ["rules:write"] as const;

export const firehoseNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: () => staticProviderUrl("api.firehose.com", ["v1", "rules"]),
    description: "List Firehose monitoring rules configured for the connected account.",
    hosts: HOSTS,
    inputSchema: objectSchema({}),
    provider: "firehose",
    requiredScopes: FIREHOSE_RULE_READ_SCOPES,
    resourceTypes: ["account"],
    sampleInput: {},
    toolName: "firehose.rules.list",
  }),
  acquisitionWrite({
    buildBody: (input) => bodyFromFields(input, ["value", "tag", "nsfw", "quality"]),
    buildUrl: () => staticProviderUrl("api.firehose.com", ["v1", "rules"]),
    description: "Create a Firehose monitoring rule after explicit approval.",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        nsfw: booleanProperty(),
        quality: booleanProperty(),
        tag: stringProperty("Optional label returned with matching stream events."),
        value: stringProperty("Firehose rule query."),
      },
      ["value"],
    ),
    method: "POST",
    provider: "firehose",
    requiredScopes: FIREHOSE_RULE_WRITE_SCOPES,
    resourceTypes: ["account"],
    sampleInput: { quality: true, tag: "brand", value: '"Deployments.ai" OR herdr' },
    toolName: "firehose.rules.create",
  }),
] as const;
