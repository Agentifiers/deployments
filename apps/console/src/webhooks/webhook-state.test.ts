import {
  CreateWebhookSubscriptionRequest,
  DEFAULT_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS,
  MAX_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS,
  WebhookResponse,
} from "@deployments-ai/api-contract/runtime";
import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import {
  canRetryDelivery,
  DEFAULT_OVERLAP_HOURS,
  DELIVERY_STATUSES,
  endpointChanges,
  endpointOptions,
  endpointPage,
  ENDPOINT_ACTIONS,
  headerList,
  isDeliveryInFlight,
  MAX_OVERLAP_HOURS,
  parseDeliveryFilters,
  parseEndpointSearch,
  parseOverlapHours,
  readEndpointDraft,
  type EndpointAction,
  type EndpointPage,
  type EndpointStatus,
  type WebhookEndpoint,
} from "./webhook-state.ts";

const WEBHOOK_ID = "01K0000000000000000000000W";
const BILLING = "01K00000000000000000000WH1";
const OLD_E2E = "01K00000000000000000000WH2";
const AUDIT = "01K00000000000000000000WH3";
const OLDER_E2E = "01K00000000000000000000WH4";
const CRM = "01K00000000000000000000WH5";

function endpoint(id: string, name: string, status: EndpointStatus): WebhookEndpoint {
  return Schema.decodeUnknownSync(WebhookResponse)({
    consecutiveFailures: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    environmentId: "01K0000000000000000000000E",
    eventTypes: ["run.completed"],
    id,
    name,
    object: "webhook-endpoint",
    organizationId: "01K0000000000000000000000A",
    projectId: "01K0000000000000000000000B",
    status,
    updatedAt: "2026-09-01T00:00:00.000Z",
    url: "https://hooks.example.com/events",
    version: 1,
  });
}

const ENDPOINTS = [
  endpoint(BILLING, "billing", "active"),
  endpoint(OLD_E2E, "e2e old", "archived"),
  endpoint(AUDIT, "audit", "disabled"),
  endpoint(OLDER_E2E, "e2e older", "archived"),
  endpoint(CRM, "crm", "active"),
];

const summary = ({ endpoints, ...rest }: EndpointPage) => ({
  ...rest,
  names: endpoints.map(({ name }) => name),
});

describe("endpointPage", () => {
  test("the active view keeps active and disabled endpoints in list order and counts the archived it hides", () => {
    expect(summary(endpointPage(ENDPOINTS, { offset: 0, pageSize: 25, view: "active" }))).toEqual({
      hidden: 2,
      names: ["billing", "audit", "crm"],
    });
  });

  test("a page holds pageSize endpoints from its offset and points at the next page", () => {
    const page = (offset: number) =>
      summary(endpointPage(ENDPOINTS, { offset, pageSize: 2, view: "active" }));
    expect(page(0)).toEqual({ hidden: 2, names: ["billing", "audit"], nextOffset: 2 });
    expect(page(2)).toEqual({ hidden: 2, names: ["crm"] });
  });

  test("a page that ends exactly at the last endpoint has no next offset", () => {
    expect(endpointPage(ENDPOINTS, { offset: 0, pageSize: 3, view: "active" })).not.toHaveProperty(
      "nextOffset",
    );
    expect(endpointPage(ENDPOINTS, { offset: 0, pageSize: 2, view: "active" })).toHaveProperty(
      "nextOffset",
      2,
    );
  });

  test("the all view lists archived endpoints last and hides nothing", () => {
    expect(summary(endpointPage(ENDPOINTS, { offset: 0, pageSize: 25, view: "all" }))).toEqual({
      hidden: 0,
      names: ["billing", "audit", "crm", "e2e old", "e2e older"],
    });
    expect(summary(endpointPage(ENDPOINTS, { offset: 2, pageSize: 2, view: "all" }))).toEqual({
      hidden: 0,
      names: ["crm", "e2e old"],
      nextOffset: 4,
    });
  });
});

describe("endpointOptions", () => {
  const options = (selectedId: string | undefined) =>
    endpointOptions(ENDPOINTS, selectedId).map(({ id, name }): readonly string[] => [name, id]);
  const live = [
    ["audit", AUDIT],
    ["billing", BILLING],
    ["crm", CRM],
  ];

  test("lists live endpoints by name and leaves archived ones out", () => {
    expect(options(undefined)).toEqual(live);
    expect(options(BILLING)).toEqual(live);
  });

  test("adds the selected endpoint when it is archived", () => {
    expect(options(OLD_E2E)).toEqual([...live, ["e2e old", OLD_E2E]]);
  });
});

test("parseEndpointSearch keeps show=all and drops every other value, so the active view is the bare path", () => {
  expect(parseEndpointSearch({ show: "all" })).toEqual({ show: "all" });
  expect(parseEndpointSearch({ show: "active" })).toEqual({});
  expect(parseEndpointSearch({ show: ["all"] })).toEqual({});
  expect(parseEndpointSearch({})).toEqual({});
});

describe("ENDPOINT_ACTIONS", () => {
  const statusesOffering = (action: EndpointAction) =>
    Object.entries(ENDPOINT_ACTIONS)
      .filter(([, actions]) => actions.includes(action))
      .map(([status]) => status)
      .toSorted();

  test("live endpoints toggle to the other live status; archived endpoints offer nothing", () => {
    expect(statusesOffering("disable")).toEqual(["active"]);
    expect(statusesOffering("enable")).toEqual(["disabled"]);
    for (const action of ["archive", "edit", "rotate", "test"] as const) {
      expect(statusesOffering(action)).toEqual(["active", "disabled"]);
    }
  });
});

describe("deliveries", () => {
  test("only pending, retrying, and sending deliveries are in flight", () => {
    expect(DELIVERY_STATUSES.filter(isDeliveryInFlight)).toEqual([
      "pending",
      "retrying",
      "sending",
    ]);
  });

  test("a settled delivery is retryable only toward an active endpoint", () => {
    const retryable = (endpoint: "active" | "archived" | "disabled" | undefined) =>
      DELIVERY_STATUSES.filter((status) => canRetryDelivery({ status }, endpoint));
    expect(retryable("active")).toEqual(["delivered", "failed"]);
    expect(retryable("disabled")).toEqual([]);
    expect(retryable("archived")).toEqual([]);
    expect(retryable(undefined)).toEqual([]);
  });
});

describe("parseDeliveryFilters", () => {
  test("keeps a known status and a ULID endpoint", () => {
    expect(parseDeliveryFilters({ status: "failed", webhookId: WEBHOOK_ID })).toEqual({
      status: "failed",
      webhookId: WEBHOOK_ID,
    });
  });

  test("drops unknown statuses and malformed IDs", () => {
    expect(parseDeliveryFilters({ status: "lost", webhookId: "not-an-id" })).toEqual({});
    expect(parseDeliveryFilters({ status: 3, webhookId: WEBHOOK_ID.toLowerCase() })).toEqual({});
  });
});

describe("headerList", () => {
  test("sorts headers by name and stringifies values that are not strings", () => {
    expect(
      headerList({ "x-request-id": "req-1", "content-type": "application/json", retry: 2 }),
    ).toEqual([
      ["content-type", "application/json"],
      ["retry", "2"],
      ["x-request-id", "req-1"],
    ]);
  });

  test("reads absent headers as none", () => {
    expect(headerList(undefined)).toEqual([]);
  });
});

describe("endpointChanges", () => {
  const endpoint = {
    eventTypes: ["run.completed", "run.failed"],
    name: "Billing",
    url: "https://hooks.example.com/billing",
  };

  test("sends only the fields that differ from the endpoint", () => {
    expect(
      endpointChanges(endpoint, {
        eventTypes: ["run.failed", "run.completed"],
        name: "Billing events",
        url: "https://hooks.example.com/billing",
      }),
    ).toEqual({ name: "Billing events" });
    expect(
      endpointChanges(endpoint, {
        eventTypes: ["run.failed"],
        name: "Billing",
        url: "https://hooks.example.com/v2",
      }),
    ).toEqual({ eventTypes: ["run.failed"], url: "https://hooks.example.com/v2" });
  });

  test("is empty when nothing changed", () => {
    expect(endpointChanges(endpoint, endpoint)).toEqual({});
  });
});

describe("readEndpointDraft", () => {
  const draft = {
    all: false,
    eventTypes: "run.completed",
    name: "Billing",
    url: "https://hooks.example.com/billing",
  };
  const contractAccepts = (request: unknown) =>
    Option.isSome(Schema.decodeUnknownOption(CreateWebhookSubscriptionRequest)(request));

  test("trims the fields into a create request", () => {
    expect(
      readEndpointDraft({
        ...draft,
        name: " Billing ",
        url: " https://hooks.example.com/billing\n",
      }).value,
    ).toEqual({
      eventTypes: ["run.completed"],
      name: "Billing",
      url: "https://hooks.example.com/billing",
    });
  });

  test("rejects a blank name and a URL that is not HTTPS", () => {
    expect(readEndpointDraft({ ...draft, name: "  " })).toMatchObject({
      nameValid: false,
      value: undefined,
    });
    expect(readEndpointDraft({ ...draft, url: "http://hooks.example.com" })).toMatchObject({
      urlValid: false,
      value: undefined,
    });
  });

  test("accepts exactly the name and URL lengths the contract accepts", () => {
    const url = (length: number) => `https://h.example/${"a".repeat(length - 18)}`;
    const drafts = [
      { ...draft, name: "n".repeat(120) },
      { ...draft, name: "n".repeat(121) },
      { ...draft, url: url(2_048) },
      { ...draft, url: url(2_049) },
    ];
    expect(
      drafts.map(({ name, url }) => [
        readEndpointDraft({ ...draft, name, url }).value !== undefined,
        contractAccepts({ eventTypes: ["run.completed"], name, url }),
      ]),
    ).toEqual([
      [true, true],
      [false, false],
      [true, true],
      [false, false],
    ]);
  });
});

describe("parseOverlapHours", () => {
  test("converts whole hours into seconds", () => {
    expect(parseOverlapHours(" 24 ")).toEqual({ ok: true, seconds: 86_400 });
    expect(parseOverlapHours("0")).toEqual({ ok: true, seconds: 0 });
  });

  test("defaults to the contract's overlap and stops at the contract's maximum", () => {
    expect(parseOverlapHours(String(DEFAULT_OVERLAP_HOURS))).toEqual({
      ok: true,
      seconds: DEFAULT_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS,
    });
    expect(parseOverlapHours(String(MAX_OVERLAP_HOURS))).toEqual({
      ok: true,
      seconds: MAX_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS,
    });
    expect(parseOverlapHours(String(MAX_OVERLAP_HOURS + 1))).toEqual({
      message: "Enter whole hours from 0 to 168.",
      ok: false,
    });
  });

  test("rejects blanks, fractions, negatives, and exponents", () => {
    for (const text of ["", "1.5", "-1", "1e2"]) {
      expect(parseOverlapHours(text)).toEqual({
        message: "Enter whole hours from 0 to 168.",
        ok: false,
      });
    }
  });
});
