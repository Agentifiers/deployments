import { optionalToolString, requireToolString } from "../core.ts";
import {
  integerProperty,
  objectSchema,
  staticProviderUrl,
  stringProperty,
} from "../tool-definition-builders.ts";
import { businessRead, businessWrite, twilioFormBody } from "./common.ts";

const HOSTS = ["api.twilio.com"] as const;
const E164_PATTERN = "^\\+[1-9]\\d{6,14}$";

function twilioUrl(input: Record<string, unknown>, path: readonly string[]): string {
  const accountSid = requireToolString(input, "accountSid");
  return staticProviderUrl("api.twilio.com", ["2010-04-01", "Accounts", accountSid, ...path]);
}

function twilioAccountUrl(input: Record<string, unknown>): string {
  const accountSid = requireToolString(input, "accountSid");
  return staticProviderUrl("api.twilio.com", ["2010-04-01", "Accounts", `${accountSid}.json`]);
}

function twilioListUrl(input: Record<string, unknown>, path: readonly string[]): string {
  const url = new URL(twilioUrl(input, path));
  const fields: readonly [string, string][] = [
    ["pageSize", "PageSize"],
    ["to", "To"],
    ["from", "From"],
    ["phoneNumber", "PhoneNumber"],
    ["dateSentAfter", "DateSent>"],
    ["dateSentBefore", "DateSent<"],
  ];
  for (const [inputKey, queryKey] of fields) {
    const value = optionalToolString(input, inputKey);
    if (value) url.searchParams.set(queryKey, value);
  }
  const pageSize = input.pageSize;
  if (typeof pageSize === "number" && Number.isFinite(pageSize)) {
    url.searchParams.set("PageSize", String(Math.min(Math.max(Math.trunc(pageSize), 1), 1000)));
  }
  return url.toString();
}

export const twilioNativeHttpToolDefinitions = [
  businessRead({
    auditSelectorKeys: ["accountSid"],
    buildUrl: twilioAccountUrl,
    description: "Read the connected Twilio account identity and status.",
    expectedHost: "api.twilio.com",
    hosts: HOSTS,
    inputSchema: objectSchema({ accountSid: stringProperty("Twilio Account SID.") }, [
      "accountSid",
    ]),
    provider: "twilio",
    resourceTypes: ["account"],
    sampleInput: { accountSid: "AC00000000000000000000000000000000" },
    toolName: "twilio.account.read",
    verificationPath: "/2010-04-01/Accounts/{accountSid}.json",
  }),
  businessRead({
    auditSelectorKeys: ["accountSid"],
    buildUrl: (input) => twilioListUrl(input, ["Messages.json"]),
    description: "List Twilio messages for an authorized account.",
    expectedHost: "api.twilio.com",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        accountSid: stringProperty("Twilio Account SID."),
        dateSentAfter: stringProperty("Optional ISO-8601 lower bound."),
        dateSentBefore: stringProperty("Optional ISO-8601 upper bound."),
        from: stringProperty("Optional E.164 sender filter."),
        pageSize: integerProperty(1, 1000),
        to: stringProperty("Optional E.164 recipient filter."),
      },
      ["accountSid"],
    ),
    provider: "twilio",
    resourceTypes: ["account"],
    sampleInput: { accountSid: "AC00000000000000000000000000000000", pageSize: 25 },
    toolName: "twilio.messages.list",
  }),
  businessRead({
    auditSelectorKeys: ["accountSid"],
    buildUrl: (input) => twilioListUrl(input, ["IncomingPhoneNumbers.json"]),
    description: "List Twilio phone numbers for an authorized account.",
    expectedHost: "api.twilio.com",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        accountSid: stringProperty("Twilio Account SID."),
        pageSize: integerProperty(1, 1000),
        phoneNumber: stringProperty("Optional E.164 phone-number filter."),
      },
      ["accountSid"],
    ),
    provider: "twilio",
    resourceTypes: ["account"],
    sampleInput: { accountSid: "AC00000000000000000000000000000000", pageSize: 25 },
    toolName: "twilio.phone_numbers.list",
  }),
  businessWrite({
    auditSelectorKeys: ["accountSid", "to", "from"],
    buildBody: twilioFormBody,
    buildUrl: (input) => twilioUrl(input, ["Messages.json"]),
    description: "Send an approved Twilio SMS message to an explicitly supplied recipient.",
    // Twilio fetches each `mediaUrls` entry the input names.
    egress: "public",
    expectedHost: "api.twilio.com",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        accountSid: stringProperty("Twilio Account SID."),
        body: stringProperty("SMS body."),
        from: { minLength: 1, pattern: E164_PATTERN, type: "string" },
        mediaUrls: { items: stringProperty(), minItems: 1, type: "array" },
        to: { minLength: 1, pattern: E164_PATTERN, type: "string" },
      },
      ["accountSid", "body", "from", "to"],
    ),
    method: "POST",
    provider: "twilio",
    resourceTypes: ["account"],
    sampleInput: {
      accountSid: "AC00000000000000000000000000000000",
      body: "Approved message",
      from: "+15550000001",
      to: "+15550000002",
    },
    toolName: "twilio.messages.send",
  }),
] as const;
