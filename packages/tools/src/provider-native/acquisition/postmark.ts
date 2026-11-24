import {
  jsonObjectProperty,
  objectSchema,
  staticProviderUrl,
} from "../tool-definition-builders.ts";
import { acquisitionRead, acquisitionWrite, bodyFromFields } from "./common.ts";

const HOSTS = ["api.postmarkapp.com"] as const;

export const postmarkNativeHttpToolDefinitions = [
  acquisitionRead({
    buildUrl: () => staticProviderUrl("api.postmarkapp.com", ["server"]),
    description: "Read the connected Postmark server summary.",
    hosts: HOSTS,
    inputSchema: objectSchema({}),
    provider: "postmark",
    resourceTypes: ["account"],
    sampleInput: {},
    toolName: "postmark.server.read",
  }),
  acquisitionWrite({
    buildBody: (input) =>
      bodyFromFields(input, ["From", "To", "Subject", "TextBody", "HtmlBody", "MessageStream"]),
    buildUrl: () => staticProviderUrl("api.postmarkapp.com", ["email"]),
    description: "Send a Postmark email after explicit approval.",
    egress: "public",
    hosts: HOSTS,
    inputSchema: objectSchema({ body: jsonObjectProperty() }, ["body"]),
    method: "POST",
    provider: "postmark",
    resourceTypes: ["account"],
    sampleInput: {
      body: { From: "sender@example.com", To: "user@example.com", Subject: "Approved send" },
    },
    toolName: "postmark.email.send",
  }),
] as const;
