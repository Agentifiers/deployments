import {
  jsonObjectProperty,
  objectSchema,
  staticProviderUrl,
} from "../tool-definition-builders.ts";
import { acquisitionRead, acquisitionWrite, bodyFromFields } from "./common.ts";

const HOSTS = ["my.demio.com"] as const;

export const demioNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: () => staticProviderUrl("my.demio.com", ["api", "v1", "ping"]),
    description: "Run the documented Demio authentication health check.",
    hosts: HOSTS,
    inputSchema: objectSchema({}),
    provider: "demio",
    requiredScopes: ["account:read"],
    resourceTypes: ["account"],
    sampleInput: {},
    toolName: "demio.account.ping",
  }),
  acquisitionWrite({
    buildBody: (input) => bodyFromFields(input, ["event_id", "name", "email", "date_id"]),
    buildUrl: () => staticProviderUrl("my.demio.com", ["api", "v1", "event", "register"]),
    description: "Register an attendee for a Demio event after explicit approval.",
    egress: "public",
    hosts: HOSTS,
    inputSchema: objectSchema({ body: jsonObjectProperty() }, ["body"]),
    method: "POST",
    provider: "demio",
    requiredScopes: ["registrations:write"],
    resourceTypes: ["account"],
    sampleInput: { body: { event_id: "event_1", email: "attendee@example.com", name: "Attendee" } },
    toolName: "demio.event.registration.create",
  }),
] as const;
